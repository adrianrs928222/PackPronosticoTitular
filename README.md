# PRONÓSTICO TITULAR VIP

Web lista para GitHub + Render, con Stripe Checkout (10 €/mes), comprobación del pago en servidor, invitaciones privadas de Telegram por **solicitud de acceso**, control de suscripciones y portal de cancelación.

## Qué hace

- Web responsive en español, botón **COMPRAR POR 10 €**, precio y renovación mensual visibles.
- Stripe Checkout crea una suscripción recurrente usando **STRIPE_PRICE_ID**.
- El servidor verifica la sesión directamente contra Stripe; no confía en parámetros de pago sin comprobar.
- Solo una suscripción activa y pagada obtiene un enlace de invitación exclusivo, que caduca en una hora.
- La invitación usa `creates_join_request`: cuando el cliente solicita entrar, el bot identifica su cuenta de Telegram **sin que tenga que hablarle**. Aprueba solo a un miembro por compra y revoca la invitación después.
- Stripe webhooks sincronizan renovaciones, cancelaciones y estados de suscripción. El bot expulsa al miembro cuando la suscripción deja de estar activa.
- Portal de Stripe para gestionar o cancelar la suscripción.
- PostgreSQL persistente, sin depender del disco efímero de Render.

## Antes de desplegar

1. El canal debe ser **privado**. Revoca los enlaces públicos/antiguos que permitan entrar sin pagar. **No utilices `t.me/pronosticotitular` como invitación VIP**.
2. Añade el bot existente como administrador del canal con permiso de **invitar usuarios** y **bloquear/expulsar usuarios**.
3. En Stripe, crea o selecciona un precio **recurrente mensual de 10 EUR** y copia su identificador `price_...`. No uses el identificador del producto `prod_...` ni el enlace `buy.stripe.com`.
4. Antes de producción, utiliza **Stripe test mode** (clave `sk_test_...` y precio de prueba). Las claves de test y live NO se mezclan.
5. Revisa las condiciones de Stripe para servicios de pronósticos deportivos/apuestas y confirma que tu actividad está autorizada. No se garantiza aprobación del proveedor.

## Subir a GitHub

1. Descomprime el ZIP y sube **los archivos de la carpeta** a un repositorio privado de GitHub (o `git init`, `git add .`, `git commit`, `git push`).
2. No subas `.env` ni secretos: están excluidos por `.gitignore`.
3. En Render, **New → Blueprint** y selecciona ese repositorio. Render leerá `render.yaml` y creará el servicio web y PostgreSQL. Revisa precios de los planes antes de confirmar.
4. En el panel de Render introduce los valores secretos que figuran en `.env.example` y el `PUBLIC_URL` real (`https://<nombre>.onrender.com`). El servicio web debe desplegarse después de configurar las variables.

## Variables de entorno

| Variable | Descripción |
| --- | --- |
| `PUBLIC_URL` | URL pública HTTPS de Render, sin barra final |
| `DATABASE_URL` | PostgreSQL, enlazada automáticamente por el Blueprint |
| `STRIPE_SECRET_KEY` | Clave secreta Stripe, de **test** durante pruebas |
| `STRIPE_PRICE_ID` | Precio mensual `price_...` en el mismo modo/cuenta que la clave |
| `STRIPE_WEBHOOK_SECRET` | Secreto de firma del webhook `whsec_...` |
| `TELEGRAM_BOT_TOKEN` | Token privado del bot que ya tienes |
| `TELEGRAM_CHANNEL_ID` | `-1003928777002` (confirmar que sigue siendo tu canal) |
| `TELEGRAM_WEBHOOK_SECRET` | Cadena aleatoria de al menos 32 caracteres, generada por Render |
| `COOKIE_SECRET` | Cadena aleatoria de al menos 32 caracteres, generada por Render |
| `NODE_ENV` | `production` en Render |

## Configurar Stripe (necesario)

En Stripe Workbench → Webhooks crea un **nuevo destino** para esta web:

`https://TU-SERVICIO.onrender.com/webhooks/stripe`

Suscríbelo a estos eventos:

- `checkout.session.completed`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Copia el **signing secret** `whsec_...` de este destino a `STRIPE_WEBHOOK_SECRET` en Render. El webhook antiguo de Make es distinto; no reutilices su `whsec` ni su URL. Mantén Make inactivo para evitar envíos duplicados.

En Stripe Billing → Customer portal, habilita el portal y la opción de cancelación, según las condiciones comerciales.

## Configurar webhook Telegram (necesario, una vez)

Después del despliegue, llama a `setWebhook` desde tu ordenador, **sin publicar el token**. Por ejemplo, con Node instalado, crea localmente un `.env` con `PUBLIC_URL`, `TELEGRAM_BOT_TOKEN` y `TELEGRAM_WEBHOOK_SECRET` (el mismo de Render) y ejecuta:

```bash
npm install
npm run setup:telegram
```

También puedes ejecutarlo localmente con variables de entorno. El bot debe tener permisos de administrador. **No ejecutes este script desde un repositorio público ni compartas el token**.

## Probar antes de lanzar

1. Abre la URL de Render y verifica que se ve el precio **10 €/mes**.
2. En modo de prueba de Stripe, pulsa **COMPRAR POR 10 €** y utiliza una tarjeta de prueba documentada por Stripe (por ejemplo, `4242 4242 4242 4242`, con fecha futura y CVC cualquiera).
3. Debes llegar a `/success`, ver **¡Pago confirmado!** y el botón **ACCEDER A MI PACK VIP**.
4. Pulsa el enlace con Telegram, solicita entrar y comprueba que el bot aprueba el acceso.
5. Desde el portal de Stripe, cancela la suscripción y prueba la revocación en el momento en que Stripe cambie su estado a inactivo. Si la cancelación es **al final del periodo**, el acceso se mantiene hasta ese momento.
6. Comprueba las entregas y errores de los dos webhooks antes de pasar a claves live. Repite las pruebas en el entorno live con un pago controlado y autorización del proveedor.

## Consideraciones operativas

- La primera entrada requiere pulsar **Solicitar unirme** en Telegram; el bot no necesita chat `/start`.
- El enlace de solicitud de acceso se revoca tras aprobar una persona, y no se publica en la web para usuarios sin pago. Telegram no permite combinar `creates_join_request` con `member_limit=1`; el servidor impone el límite al aprobar.
- Si el cliente pierde su sesión/cookie o el enlace de Stripe, no hay todavía un mecanismo de recuperación por correo. Puede añadirse con autenticación de correo verificado.
- Si Telegram falla al expulsar a alguien, el error se registra. **Para un servicio comercial de producción es recomendable añadir un proceso de reconciliación/reintentos y alertas**, especialmente en las bajas.
- Una URL de confirmación o cookie robada podría permitir a otra persona solicitar la primera entrada. Para seguridad más estricta, añade autenticación de usuario o enlace de recuperación por correo verificado antes de ofrecer el servicio a gran escala.
- No se garantiza rendimiento económico de pronósticos. Incluye aviso legal, privacidad, política de cancelación y condiciones del servicio adecuados a tu actividad y jurisdicción antes del lanzamiento.

## Desarrollo local

```bash
cp .env.example .env
npm install
npm run dev
```

Requiere Node 20+ y PostgreSQL accesible. La aplicación crea sus tablas al iniciar.
