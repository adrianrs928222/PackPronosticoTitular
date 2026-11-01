document.getElementById('year').textContent = new Date().getFullYear();
const buy = document.getElementById('buy');
buy?.addEventListener('click', async () => {
  const err = document.getElementById('error'); err.hidden = true; buy.disabled = true; buy.textContent = 'Preparando pago…';
  try {
    const r = await fetch('/api/checkout', {method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    const data = await r.json(); if (!r.ok || !data.url) throw Error(data.error || 'No se pudo iniciar el pago');
    window.location.assign(data.url);
  } catch(e) { err.textContent = e.message; err.hidden = false; buy.disabled = false; buy.innerHTML = 'COMPRAR POR 10 € <span>↗</span>'; }
});
