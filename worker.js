/* worker.js */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    const sessionId = getSessionId(req);
    if (url.pathname === "/") return env.SESSIONS.get(sessionId).then(s => s ? readerHTML(env, true) : readerHTML(env, false));
    if (url.pathname === "/buy") return createCheckoutSession(env, req);
    if (url.pathname === "/claim") return claim(env, url);
    if (url.pathname.startsWith("/page/")) return servePage(env, req, url, sessionId);
    return new Response("Not found", { status: 404 });
  }
};

function getSessionId(req) {
  const cookie = req.headers.get("Cookie") || "";
  const m = cookie.match(/ebook_session=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : "";
}

async function createCheckoutSession(env, req) {
  const origin = new URL(req.url).origin;
  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][price]": env.PRICE_ID,
    "line_items[0][quantity]": "1",
    success_url: `${origin}/claim?cs={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/`
  });
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await r.json();
  if (!data.url) return new Response("Stripe error", { status: 500 });
  return Response.redirect(data.url, 302);
}

async function claim(env, url) {
  const cs = url.searchParams.get("cs");
  if (!cs) return Response.redirect("/", 302);
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions/" + cs, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  const data = await r.json();
  if (data.payment_status !== "paid") return new Response("Payment not verified", { status: 402 });

  const sid = cryptoRandom(24);
  await env.SESSIONS.put(sid, "ok", { expirationTtl: 60 * 60 * 24 * 365 });
  const res = Response.redirect("/", 302);
  res.headers.set("Set-Cookie", `ebook_session=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60*60*24*365}`);
  return res;
}

async function servePage(env, req, url, sid) {
  const ok = sid && await env.SESSIONS.get(sid);
  if (!ok) return new Response("Unauthorized", { status: 401 });
  const n = parseInt(url.pathname.split("/").pop() || "1", 10);
  if (isNaN(n) || n < 1 || n > Number(env.PAGE_COUNT)) return new Response("No page", { status: 404 });
  const name = String(n).padStart(4, "0") + ".png";
  const obj = await env.PAGES.get(`pages/${name}`);
  if (!obj) return new Response("Missing", { status: 404 });
  const headers = new Headers();
  headers.set("Content-Type", "image/png");
  headers.set("Cache-Control", "private, max-age=3600");
  return new Response(obj.body, { headers });
}

function readerHTML(env, unlocked) {
  const head = `
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${env.TITLE}</title>
<style>
  html,body { margin:0; background:#0b0e13; color:#e6e6e6; font:16px/1.5 system-ui, -apple-system, Segoe UI, Roboto; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 24px; }
  h1 { margin: 0 0 16px 0; font-weight: 700; }
  .frame { position: relative; user-select: none; }
  .frame img { width: 100%; display: block; }
  .veil { position:absolute; inset:0; pointer-events:none; }
  .controls { display:flex; gap:8px; margin:16px 0; }
  button { border:0; padding:10px 14px; border-radius:10px; background:#1a1f2b; color:#fff; cursor:pointer; }
  button:disabled { opacity:.4; cursor:not-allowed; }
  .noselect, img, canvas, .frame { -webkit-user-select:none; -ms-user-select:none; user-select:none; }
</style>
<script>
  document.addEventListener('copy', e => e.preventDefault());
  document.addEventListener('cut', e => e.preventDefault());
  document.addEventListener('contextmenu', e => e.preventDefault());
</script>`;
  const lockedView = `
<div class="wrap">
  <h1>${env.TITLE}</h1>
  <p>This book is presented one page at a time inside a protected reader. Click the button to purchase and unlock instant access.</p>
  <p><a href="/buy"><button>Buy & Unlock</button></a></p>
</div>`;
  const unlockedView = `
<div class="wrap">
  <h1>${env.TITLE}</h1>
  <div class="controls">
    <button id="prev">Previous</button>
    <div id="pos" class="noselect"></div>
    <button id="next">Next</button>
  </div>
  <div class="frame">
    <img id="page" alt="Page">
    <div class="veil"></div>
  </div>
</div>
<script>
  const total = ${Number(env.PAGE_COUNT)};
  let n = 1;
  const img = document.getElementById('page');
  const pos = document.getElementById('pos');
  const prev = document.getElementById('prev');
  const next = document.getElementById('next');
  function load(i) {
    n = i;
    img.src = '/page/' + n + '?t=' + Date.now();
    pos.textContent = 'Page ' + n + ' of ' + total;
    prev.disabled = n <= 1;
    next.disabled = n >= total;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  prev.onclick = () => n>1 && load(n-1);
  next.onclick = () => n<total && load(n+1);
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') prev.onclick();
    if (e.key === 'ArrowRight') next.onclick();
  });
  load(1);
</script>`;
  return new Response(head + (unlocked ? unlockedView : lockedView), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function cryptoRandom(len) {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, "").slice(0, len);
}
