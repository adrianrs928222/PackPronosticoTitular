const params = new URLSearchParams(location.search);
const session = params.get('session_id');
const heading = document.getElementById('heading');
const status = document.getElementById('status');
const error = document.getElementById('error');
const access = document.getElementById('access');
const invite = document.getElementById('invite');
const joinstate = document.getElementById('joinstate');
let checks = 0;
async function check(){
  try {
    const path = session ? `/api/access?session_id=${encodeURIComponent(session)}` : '/api/access';
    const r = await fetch(path, {credentials:'same-origin'});
    const d = await r.json();
    if (!r.ok) throw Error(d.error || 'No se pudo verificar la compra');
    if (d.status === 'pending' && checks++ < 12) { heading.textContent='Confirmando el pago…'; status.textContent='Esperando la confirmación de Stripe.'; setTimeout(check, 2500); return; }
    if (d.status === 'pending') throw Error('El pago aún no está confirmado. Recarga esta página en unos instantes.');
    if (d.status === 'joined') { heading.textContent='¡Ya tienes acceso!'; status.textContent='Tu cuenta de Telegram ya está vinculada al pack VIP.'; access.hidden=false; invite.hidden=true; joinstate.textContent='Si necesitas asistencia, contacta con el administrador del canal.'; return; }
    if (d.status !== 'active' || !d.invite_url) throw Error('La suscripción no está activa o el enlace no está disponible.');
    heading.textContent='¡Pago confirmado!'; status.textContent='Tu pack VIP está listo.'; access.hidden=false; invite.href=d.invite_url;
    joinstate.textContent='Invitación personal. No la compartas.';
  } catch(e) { heading.textContent='No se pudo activar el acceso'; status.textContent=''; error.textContent=e.message; error.hidden=false; }
}
document.getElementById('portal').addEventListener('click', async () => {
  try { const r=await fetch('/api/portal',{method:'POST'});const d=await r.json();if(!r.ok)throw Error(d.error);location.assign(d.url); }
  catch(e){error.textContent=e.message;error.hidden=false;}
});
check();
