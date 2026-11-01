import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import Stripe from 'stripe';
import pg from 'pg';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const required=['PUBLIC_URL','DATABASE_URL','STRIPE_SECRET_KEY','STRIPE_PRICE_ID','STRIPE_WEBHOOK_SECRET','TELEGRAM_BOT_TOKEN','TELEGRAM_CHANNEL_ID','TELEGRAM_WEBHOOK_SECRET','COOKIE_SECRET'];
const missing=required.filter(k=>!process.env[k]);if(missing.length)throw Error(`Faltan variables: ${missing.join(', ')}`);
const env=process.env;
if(env.NODE_ENV==='production' && (!env.PUBLIC_URL.startsWith('https://') || env.COOKIE_SECRET.length<32 || env.TELEGRAM_WEBHOOK_SECRET.length<32))throw Error('PUBLIC_URL debe ser HTTPS y los secretos tener al menos 32 caracteres');
const stripe=new Stripe(env.STRIPE_SECRET_KEY);
const db=new pg.Pool({connectionString:env.DATABASE_URL,ssl:env.DATABASE_URL.includes('localhost')?false:{rejectUnauthorized:false}});
const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],imgSrc:["'self'","data:"],connectSrc:["'self'"],formAction:["'self'"],frameAncestors:["'none'"],upgradeInsecureRequests:env.NODE_ENV==='production'?[]:null}}}));
app.use(cookieParser());
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'public');
const base=env.PUBLIC_URL.replace(/\/$/,'');
const tgBase=`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const safe=(fn)=>async(req,res)=>{try{await fn(req,res)}catch(err){console.error('Request error:',err.message);if(!res.headersSent)res.status(500).json({error:'Error temporal. Inténtalo de nuevo.'});}};
async function telegram(method,params){const r=await fetch(`${tgBase}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(params)});const j=await r.json();if(!j.ok)throw Error(`Telegram ${method}: ${j.description}`);return j.result;}
async function init(){await db.query(`CREATE TABLE IF NOT EXISTS members(
 id BIGSERIAL PRIMARY KEY, stripe_session_id TEXT UNIQUE NOT NULL, stripe_customer_id TEXT NOT NULL,
 stripe_subscription_id TEXT UNIQUE NOT NULL, email TEXT, status TEXT NOT NULL DEFAULT 'pending',
 telegram_user_id TEXT, invite_url TEXT, invite_name TEXT, invite_expires_at TIMESTAMPTZ,
 joined_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
); CREATE INDEX IF NOT EXISTS members_customer_idx ON members(stripe_customer_id);
 CREATE TABLE IF NOT EXISTS processed_events(event_id TEXT PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT now());
 CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL);
 CREATE INDEX IF NOT EXISTS sessions_member_idx ON sessions(member_id);`);}
const activeStatus=s=>['active','trialing'].includes(s);
async function upsertFromCheckout(session,subscription){
 const sub=typeof subscription==='string'?await stripe.subscriptions.retrieve(subscription):subscription;
 const customer=typeof session.customer==='string'?session.customer:session.customer?.id;
 const email=session.customer_details?.email || session.customer_email || null;
 const status=activeStatus(sub.status) && (session.payment_status==='paid'||session.payment_status==='no_payment_required')?'active':'pending';
 const q=await db.query(`INSERT INTO members(stripe_session_id,stripe_customer_id,stripe_subscription_id,email,status)
 VALUES($1,$2,$3,$4,$5) ON CONFLICT(stripe_subscription_id) DO UPDATE SET
 stripe_customer_id=EXCLUDED.stripe_customer_id,email=COALESCE(EXCLUDED.email,members.email),
 status=CASE WHEN members.status='revoked' THEN members.status ELSE EXCLUDED.status END,updated_at=now() RETURNING *`,[session.id,customer,sub.id,email,status]);
 return q.rows[0];
}
async function statusUpdate(subId,status){
 const rows=(await db.query('UPDATE members SET status=$2,updated_at=now() WHERE stripe_subscription_id=$1 RETURNING *',[subId,status])).rows;
 for(const m of rows){if(status==='revoked')await revoke(m);}
}
async function revoke(m){
 if(m.invite_url) {try{await telegram('revokeChatInviteLink',{chat_id:env.TELEGRAM_CHANNEL_ID,invite_link:m.invite_url});}catch(e){console.error('Revoke invite:',e.message);}}
 if(m.telegram_user_id){
  try{await telegram('banChatMember',{chat_id:env.TELEGRAM_CHANNEL_ID,user_id:Number(m.telegram_user_id)});
      await telegram('unbanChatMember',{chat_id:env.TELEGRAM_CHANNEL_ID,user_id:Number(m.telegram_user_id),only_if_banned:true});}
  catch(e){console.error('Membership removal needs retry:',e.message);}
 }
 await db.query('UPDATE members SET invite_url=NULL,invite_name=NULL,invite_expires_at=NULL WHERE id=$1',[m.id]);
}
async function syncMember(m){
 const sub=await stripe.subscriptions.retrieve(m.stripe_subscription_id);
 if(!activeStatus(sub.status)){
  if(m.status!=='revoked')await statusUpdate(m.stripe_subscription_id,'revoked');
  return null;
 }
 // Never reactivate an explicitly revoked member without a verified paid invoice / checkout.
 if(m.status!=='active')return null;
 return sub;
}
function setSession(res,token){res.cookie('vip_session',token,{httpOnly:true,secure:env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:30*24*3600*1000});}
async function getMemberByCookie(req){const token=req.cookies.vip_session;if(!token||!/^[-_a-f0-9]{40,}$/.test(token))return null;
 const r=await db.query(`SELECT m.* FROM sessions s JOIN members m ON m.id=s.member_id WHERE s.token_hash=$1 AND s.expires_at>now()`,[sha(token)]);return r.rows[0]||null;}
async function createInvite(m){
 if(m.telegram_user_id)return {status:'joined'};
 if(m.invite_url && new Date(m.invite_expires_at).getTime()>Date.now()+60000)return {status:'active',invite_url:m.invite_url};
 if(m.invite_url){try{await telegram('revokeChatInviteLink',{chat_id:env.TELEGRAM_CHANNEL_ID,invite_link:m.invite_url});}catch(e){console.error(e.message);}}
 // Join-request links allow the bot to identify the Telegram user without asking them to message it.
 // Telegram disallows member_limit together with creates_join_request.
 const name=`VIP-${m.id}-${crypto.randomBytes(5).toString('hex')}`;
 const expires=new Date(Date.now()+60*60*1000);
 const invite=await telegram('createChatInviteLink',{chat_id:env.TELEGRAM_CHANNEL_ID,name,expire_date:Math.floor(expires.getTime()/1000),creates_join_request:true});
 await db.query('UPDATE members SET invite_url=$1,invite_name=$2,invite_expires_at=$3,updated_at=now() WHERE id=$4',[invite.invite_link,name,expires,m.id]);
 return {status:'active',invite_url:invite.invite_link};
}
app.get('/health',(_req,res)=>res.json({ok:true}));
// Stripe requires the exact raw request body to verify the signature.
app.post('/webhooks/stripe',express.raw({type:'application/json'}),safe(async(req,res)=>{
 let event;try{event=stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],env.STRIPE_WEBHOOK_SECRET)}catch{return res.status(400).json({error:'Firma Stripe inválida'});}
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  const inserted=await client.query('INSERT INTO processed_events(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id',[event.id]);
  if(!inserted.rowCount){await client.query('COMMIT');return res.json({received:true,duplicate:true});}
  // Commit deduplication only after processing; on failure Stripe retries.
  if(event.type==='checkout.session.completed'){
   const s=event.data.object;
   if(s.mode==='subscription' && s.subscription && (s.payment_status==='paid'||s.payment_status==='no_payment_required')){
    const sub=await stripe.subscriptions.retrieve(s.subscription);
    await upsertFromCheckout(s,sub);
   }
  }else if(event.type==='invoice.paid'){
   const inv=event.data.object;
   const subId=typeof inv.subscription==='string'?inv.subscription:inv.subscription?.id;
   if(subId){const sub=await stripe.subscriptions.retrieve(subId);if(activeStatus(sub.status))await db.query("UPDATE members SET status='active',updated_at=now() WHERE stripe_subscription_id=$1",[subId]);}
  }else if(event.type==='customer.subscription.deleted'){
   await statusUpdate(event.data.object.id,'revoked');
  }else if(event.type==='customer.subscription.updated'){
   const sub=event.data.object;
   if(!activeStatus(sub.status))await statusUpdate(sub.id,'revoked');
  }else if(event.type==='invoice.payment_failed'){
   // Stripe may retry; do not immediately kick during a recoverable grace period.
   console.log('Invoice payment failed; awaiting subscription status:',event.data.object.id);
  }
  await client.query('COMMIT');res.json({received:true});
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}));
app.post('/webhooks/telegram',express.json({limit:'64kb'}),safe(async(req,res)=>{
 const received=req.get('x-telegram-bot-api-secret-token')||'';
 const expected=env.TELEGRAM_WEBHOOK_SECRET;
 if(received.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(received),Buffer.from(expected)))return res.sendStatus(403);
 const jr=req.body?.chat_join_request;
 if(!jr||String(jr.chat?.id)!==String(env.TELEGRAM_CHANNEL_ID))return res.json({ok:true});
 const link=jr.invite_link?.invite_link;const user=jr.from?.id;
 if(!link||!user)return res.json({ok:true});
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  const q=await client.query('SELECT * FROM members WHERE invite_url=$1 FOR UPDATE',[link]);const m=q.rows[0];
  if(!m||m.telegram_user_id||m.status!=='active'||!m.invite_expires_at||new Date(m.invite_expires_at)<new Date()){
   await client.query('COMMIT');await telegram('declineChatJoinRequest',{chat_id:env.TELEGRAM_CHANNEL_ID,user_id:user});return res.json({ok:true});
  }
  const sub=await stripe.subscriptions.retrieve(m.stripe_subscription_id);
  if(!activeStatus(sub.status)){
   await client.query('COMMIT');await telegram('declineChatJoinRequest',{chat_id:env.TELEGRAM_CHANNEL_ID,user_id:user});return res.json({ok:true});
  }
  await telegram('approveChatJoinRequest',{chat_id:env.TELEGRAM_CHANNEL_ID,user_id:user});
  await client.query('UPDATE members SET telegram_user_id=$1,joined_at=now(),updated_at=now() WHERE id=$2',[String(user),m.id]);
  await client.query('COMMIT');
  try{await telegram('revokeChatInviteLink',{chat_id:env.TELEGRAM_CHANNEL_ID,invite_link:link});}catch(e){console.error('Revoke used invite:',e.message);}
  res.json({ok:true});
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}));
app.use(express.json({limit:'16kb'}));
app.post('/api/checkout',safe(async(req,res)=>{
 const session=await stripe.checkout.sessions.create({mode:'subscription',line_items:[{price:env.STRIPE_PRICE_ID,quantity:1}],success_url:`${base}/success?session_id={CHECKOUT_SESSION_ID}`,cancel_url:`${base}/`,billing_address_collection:'auto',allow_promotion_codes:false,subscription_data:{metadata:{product:'pronostico_titular_vip'}},locale:'es'});
 res.json({url:session.url});
}));
app.get('/api/access',safe(async(req,res)=>{
 let m=await getMemberByCookie(req);
 const sessionId=typeof req.query.session_id==='string'?req.query.session_id:null;
 if(!m && sessionId){
  if(!/^cs_(test_)?[a-zA-Z0-9]+$/.test(sessionId))return res.status(400).json({error:'Sesión de pago inválida'});
  const s=await stripe.checkout.sessions.retrieve(sessionId,{expand:['subscription']});
  if(s.mode!=='subscription'||!s.subscription)return res.json({status:'pending'});
  if(s.payment_status!=='paid'&&s.payment_status!=='no_payment_required')return res.json({status:'pending'});
  const sub=s.subscription;
  if(!activeStatus(sub.status))return res.json({status:'pending'});
  m=await upsertFromCheckout(s,sub);
  const token=crypto.randomBytes(32).toString('hex');
  await db.query("INSERT INTO sessions(token_hash,member_id,expires_at) VALUES($1,$2,now()+interval '30 days')",[sha(token),m.id]);setSession(res,token);
 }
 if(!m)return res.status(401).json({error:'Necesitas completar el pago para acceder.'});
 if(!await syncMember(m))return res.status(403).json({error:'La suscripción no está activa.'});
 const result=await createInvite(m);res.set('Cache-Control','no-store').json(result);
}));
app.post('/api/portal',safe(async(req,res)=>{
 const m=await getMemberByCookie(req);if(!m)return res.status(401).json({error:'Accede desde tu compra para gestionar la suscripción.'});
 const portal=await stripe.billingPortal.sessions.create({customer:m.stripe_customer_id,return_url:`${base}/success`});res.json({url:portal.url});
}));
app.use(express.static(root,{extensions:['html'],index:'index.html',maxAge:'1h'}));
app.get('/success',(_req,res)=>res.sendFile(path.join(root,'success.html')));
app.use((_req,res)=>res.status(404).sendFile(path.join(root,'index.html')));
await init();const port=Number(env.PORT||3000);app.listen(port,()=>console.log(`PRONÓSTICO TITULAR VIP escuchando en puerto ${port}`));
