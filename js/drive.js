// Acceso de solo lectura a archivos públicos de Google Drive mediante la Drive API v3 y una API key.
// El archivo debe estar compartido como "Cualquier persona con el enlace".
(function () {
  const API = 'https://www.googleapis.com/drive/v3/files/';
  const MIME_PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const MIME_GSLIDES = 'application/vnd.google-apps.presentation';
  const MAX_BYTES = 50 * 1024 * 1024; // todo se carga en RAM

  // Acepta un enlace de Drive/Slides o el ID directo.
  function parseId(input) {
    const s = (input || '').trim();
    const m = s.match(/\/(?:file|presentation|document)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/) ||
              s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
    if (m) return m[1];
    if (/^[A-Za-z0-9_-]{10,200}$/.test(s)) return s;
    return null;
  }

  function apiKey() {
    const k = Expo.cfg.googleApiKey;
    if (!k) throw new Error('Falta la API key de Google en app/js/config.js.');
    return encodeURIComponent(k);
  }

  async function call(url) {
    let res;
    try { res = await fetch(url); } catch { throw new Error('No se pudo conectar con Google Drive.'); }
    if (res.ok) return res;
    let reason = '';
    try {
      const j = await res.json();
      reason = (j.error && ((j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || j.error.status)) || '';
    } catch {}
    if (res.status === 404) throw new Error('Drive no encontró el archivo. Compártelo como "Cualquier persona con el enlace".');
    if (res.status === 403 && /quota|rate|limit/i.test(reason)) throw new Error('Se superó la cuota de la API de Drive. Intenta más tarde.');
    if (res.status === 403 && /export/i.test(reason)) throw new Error('Google Slides solo exporta archivos de hasta 10 MB. Descárgalo como .pptx y súbelo a Drive.');
    if (res.status === 403) throw new Error('Drive rechazó la solicitud (' + (reason || '403') + '). Revisa la API key y que el archivo sea público.');
    if (res.status === 400) throw new Error('La API key de Google no es válida o no tiene habilitada la Drive API.');
    throw new Error('Error de Google Drive (' + res.status + ').');
  }

  async function getMeta(id) {
    const res = await call(API + encodeURIComponent(id) + '?fields=id,name,mimeType,size&supportsAllDrives=true&key=' + apiKey());
    return res.json();
  }

  function kindOf(meta) {
    const name = (meta.name || '').toLowerCase();
    if (meta.mimeType === MIME_PPTX || meta.mimeType === MIME_GSLIDES || name.endsWith('.pptx')) return 'pptx';
    if (meta.mimeType === 'text/html' || /\.html?$/.test(name)) return 'html';
    return null;
  }

  // Descarga el archivo completo a memoria. onProgress(fracción 0..1 | null si se desconoce el tamaño).
  async function download(id, meta, onProgress) {
    if (meta.size && +meta.size > MAX_BYTES) throw new Error('El archivo pesa más de 50 MB.');
    const url = meta.mimeType === MIME_GSLIDES
      ? API + encodeURIComponent(id) + '/export?mimeType=' + encodeURIComponent(MIME_PPTX) + '&key=' + apiKey()
      : API + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true&key=' + apiKey();
    const res = await call(url);
    const total = +(res.headers.get('content-length') || meta.size || 0);
    if (!res.body || !onProgress) return res.arrayBuffer();

    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (got > MAX_BYTES) { reader.cancel(); throw new Error('El archivo pesa más de 50 MB.'); }
      onProgress(total ? Math.min(got / total, 1) : null);
    }
    const out = new Uint8Array(got);
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out.buffer;
  }

  window.Drive = { parseId, getMeta, kindOf, download };
})();
