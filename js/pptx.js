// Renderizador de PPTX en el navegador. Todo ocurre en memoria: el .pptx (un ZIP) se abre con JSZip
// y cada lámina se dibuja con HTML posicionado en píxeles.
// Soporta: fondos, textos con herencia de estilos (lámina → diseño → patrón), imágenes con recorte,
// formas básicas, grupos, conectores y tablas. No soporta animaciones, gráficos, SmartArt ni video.
(function () {
  const EMU_PX = 9525; // 914400 EMU = 1 pulgada = 96 px
  const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp', webp: 'image/webp' };
  const PRESET = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', orange: 'FFA500' };
  const TITLE_TYPES = new Set(['title', 'ctrTitle']);
  const BULLET_OK = /[•–\-▪■●○◦✓»>·]/;

  // ---------- utilidades XML ----------
  const kids = (el, name) => el ? Array.from(el.children).filter(c => c.localName === name) : [];
  const kid = (el, name) => el ? Array.from(el.children).find(c => c.localName === name) || null : null;
  const path = (el, ...names) => names.reduce((e, n) => kid(e, n), el);
  const first = (doc, name) => doc ? doc.getElementsByTagNameNS('*', name)[0] || null : null;
  const num = (el, attr, def) => { const v = el && el.getAttribute(attr); return v == null || v === '' ? def : +v; };
  const rid = (el, attr) => el && (el.getAttributeNS(R_NS, attr) || el.getAttribute('r:' + attr));

  function resolvePath(dir, target) {
    if (target.startsWith('/')) return target.slice(1);
    const parts = dir ? dir.split('/') : [];
    for (const seg of target.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    }
    return parts.join('/');
  }

  // ---------- paquete ----------
  async function readXml(pkg, p) {
    if (p in pkg.xml) return pkg.xml[p];
    const f = pkg.zip.file(p);
    const doc = f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null;
    return (pkg.xml[p] = doc);
  }

  async function readRels(pkg, part) {
    const i = part.lastIndexOf('/');
    const dir = part.slice(0, i), name = part.slice(i + 1);
    const doc = await readXml(pkg, dir + '/_rels/' + name + '.rels');
    const map = {};
    if (doc) for (const r of doc.getElementsByTagNameNS('*', 'Relationship')) {
      const external = r.getAttribute('TargetMode') === 'External';
      map[r.getAttribute('Id')] = {
        type: r.getAttribute('Type').split('/').pop(),
        target: external ? r.getAttribute('Target') : resolvePath(dir, r.getAttribute('Target')),
        external
      };
    }
    return map;
  }

  const relOfType = (rels, type) => Object.values(rels).find(r => r.type === type) || null;

  async function mediaUrl(pkg, p) {
    if (pkg.media.has(p)) return pkg.media.get(p);
    const type = IMG_TYPES[p.split('.').pop().toLowerCase()];
    const f = type && pkg.zip.file(p);
    let url = null;
    if (f) {
      url = URL.createObjectURL(new Blob([await f.async('arraybuffer')], { type }));
      pkg.urls.push(url);
    }
    pkg.media.set(p, url);
    return url;
  }

  // ---------- colores ----------
  function hexToRgb(h) { const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > .5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hslToRgb([h, s, l]) {
    if (!s) return [l * 255, l * 255, l * 255];
    const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }

  function applyMods(hex, el) {
    let rgb = hexToRgb(hex), alpha = 1;
    for (const m of el.children) {
      const v = num(m, 'val', 100000) / 100000;
      switch (m.localName) {
        case 'lumMod': { const h = rgbToHsl(rgb); h[2] = Math.min(1, h[2] * v); rgb = hslToRgb(h); break; }
        case 'lumOff': { const h = rgbToHsl(rgb); h[2] = Math.max(0, Math.min(1, h[2] + v)); rgb = hslToRgb(h); break; }
        case 'shade': rgb = rgb.map(c => c * v); break;
        case 'tint': rgb = rgb.map(c => c + (255 - c) * (1 - v)); break;
        case 'alpha': alpha = v; break;
      }
    }
    const [r, g, b] = rgb.map(c => Math.round(Math.max(0, Math.min(255, c))));
    return alpha < 1 ? `rgba(${r},${g},${b},${+alpha.toFixed(3)})` : `rgb(${r},${g},${b})`;
  }

  // el: cualquier elemento que contenga un hijo de color (solidFill, fillRef, gs, …).
  function color(el, ctx) {
    if (!el) return null;
    for (const c of el.children) {
      let hex;
      switch (c.localName) {
        case 'srgbClr': hex = c.getAttribute('val'); break;
        case 'sysClr': hex = c.getAttribute('lastClr') || '000000'; break;
        case 'prstClr': hex = PRESET[c.getAttribute('val')]; break;
        case 'schemeClr': {
          let v = c.getAttribute('val');
          if (v === 'phClr' && ctx.phClr) return ctx.phClr;
          v = ctx.clrMap[v] || v;
          hex = ctx.theme.colors[v];
          break;
        }
        default: continue;
      }
      return hex ? applyMods(hex, c) : null;
    }
    return null;
  }

  // ---------- rellenos ----------
  // Devuelve un valor CSS para "background" o null si no hay relleno definido; 'none' si es noFill.
  async function fill(spPr, ctx, rels) {
    if (!spPr) return null;
    for (const c of spPr.children) {
      switch (c.localName) {
        case 'noFill': return 'none';
        case 'solidFill': return color(c, ctx);
        case 'gradFill': {
          const stops = kids(kid(c, 'gsLst'), 'gs')
            .map(gs => `${color(gs, ctx) || 'transparent'} ${num(gs, 'pos', 0) / 1000}%`);
          if (!stops.length) return null;
          const lin = kid(c, 'lin');
          if (kid(c, 'path')) return `radial-gradient(circle, ${stops.join(',')})`;
          const ang = lin ? num(lin, 'ang', 0) / 60000 : 0;
          return `linear-gradient(${ang + 90}deg, ${stops.join(',')})`;
        }
        case 'blipFill': {
          const url = await blipUrl(c, ctx, rels);
          return url ? `center / cover no-repeat url("${url}")` : null;
        }
      }
    }
    return null;
  }

  async function blipUrl(blipFill, ctx, rels) {
    const blip = kid(blipFill, 'blip');
    const r = rels[rid(blip, 'embed')];
    return r && !r.external ? mediaUrl(ctx.pkg, r.target) : null;
  }

  async function background(cSld, ctx, rels) {
    const bg = kid(cSld, 'bg');
    if (!bg) return null;
    const bgPr = kid(bg, 'bgPr');
    if (bgPr) { const f = await fill(bgPr, ctx, rels); return f === 'none' ? null : f; }
    const ref = kid(bg, 'bgRef');
    return ref ? color(ref, ctx) : null;
  }

  // ---------- tema y patrón ----------
  async function loadMaster(pkg, masterPath) {
    if (pkg.masters[masterPath]) return pkg.masters[masterPath];
    const doc = await readXml(pkg, masterPath);
    const rels = await readRels(pkg, masterPath);
    const themeRel = relOfType(rels, 'theme');
    const themeDoc = themeRel ? await readXml(pkg, themeRel.target) : null;
    const colors = {};
    const scheme = first(themeDoc, 'clrScheme');
    if (scheme) for (const c of scheme.children) {
      const v = c.firstElementChild;
      if (v) colors[c.localName] = v.localName === 'sysClr' ? (v.getAttribute('lastClr') || '000000') : v.getAttribute('val');
    }
    const font = n => { const f = first(themeDoc, n); const l = kid(f, 'latin'); return l ? l.getAttribute('typeface') : ''; };
    const clrMap = {};
    const cm = first(doc, 'clrMap');
    if (cm) for (const a of cm.attributes) clrMap[a.name] = a.value;
    const master = {
      path: masterPath, doc, rels,
      theme: { colors, major: font('majorFont'), minor: font('minorFont') },
      clrMap,
      phs: placeholders(doc),
      txStyles: first(doc, 'txStyles')
    };
    return (pkg.masters[masterPath] = master);
  }

  function phInfo(node) {
    const nv = node.firstElementChild; // nvSpPr / nvPicPr / …
    const ph = kid(kid(nv, 'nvPr'), 'ph');
    if (!ph) return null;
    return { type: ph.getAttribute('type') || 'obj', idx: ph.getAttribute('idx') };
  }

  function placeholders(doc) {
    const list = [];
    const tree = first(doc, 'spTree');
    for (const n of tree ? tree.children : []) {
      const info = (n.localName === 'sp' || n.localName === 'pic') && phInfo(n);
      if (info) list.push({ ...info, node: n });
    }
    return list;
  }

  function findPh(list, info, inMaster) {
    if (!info || !list) return null;
    const norm = t => inMaster ? (t === 'ctrTitle' ? 'title' : ['subTitle', 'obj', 'body'].includes(t) ? 'body' : t) : t;
    const want = norm(info.type);
    if (!inMaster && info.idx != null) {
      const byIdx = list.find(p => p.idx === info.idx);
      if (byIdx) return byIdx.node;
    }
    const byType = list.find(p => norm(p.type) === want) ||
      (TITLE_TYPES.has(info.type) ? list.find(p => TITLE_TYPES.has(p.type)) : null);
    return byType ? byType.node : null;
  }

  // ---------- geometría ----------
  function xfrmOf(node) {
    const spPr = kid(node, 'spPr') || kid(node, 'grpSpPr');
    return kid(spPr, 'xfrm') || kid(node, 'xfrm');
  }

  function box(xfrm, T) {
    const off = kid(xfrm, 'off'), ext = kid(xfrm, 'ext');
    if (!off || !ext) return null;
    return {
      x: num(off, 'x', 0) * T.sx + T.tx,
      y: num(off, 'y', 0) * T.sy + T.ty,
      w: num(ext, 'cx', 0) * T.sx,
      h: num(ext, 'cy', 0) * T.sy,
      rot: num(xfrm, 'rot', 0) / 60000,
      flipH: xfrm.getAttribute('flipH') === '1',
      flipV: xfrm.getAttribute('flipV') === '1'
    };
  }

  function place(el, b) {
    Object.assign(el.style, {
      position: 'absolute',
      left: b.x / EMU_PX + 'px', top: b.y / EMU_PX + 'px',
      width: b.w / EMU_PX + 'px', height: b.h / EMU_PX + 'px'
    });
    const t = [];
    if (b.rot) t.push(`rotate(${b.rot}deg)`);
    if (b.flipH) t.push('scaleX(-1)');
    if (b.flipV) t.push('scaleY(-1)');
    if (t.length) el.style.transform = t.join(' ');
  }

  const CLIP = {
    triangle: 'polygon(50% 0,100% 100%,0 100%)',
    rtTriangle: 'polygon(0 0,100% 100%,0 100%)',
    diamond: 'polygon(50% 0,100% 50%,50% 100%,0 50%)',
    rightArrow: 'polygon(0 25%,60% 25%,60% 0,100% 50%,60% 100%,60% 75%,0 75%)',
    leftArrow: 'polygon(100% 25%,40% 25%,40% 0,0 50%,40% 100%,40% 75%,100% 75%)',
    chevron: 'polygon(0 0,75% 0,100% 50%,75% 100%,0 100%,25% 50%)',
    homePlate: 'polygon(0 0,80% 0,100% 50%,80% 100%,0 100%)',
    parallelogram: 'polygon(25% 0,100% 0,75% 100%,0 100%)',
    hexagon: 'polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)'
  };

  function geometry(el, spPr, b) {
    const prst = kid(spPr, 'prstGeom');
    const g = prst ? prst.getAttribute('prst') : 'rect';
    if (g === 'ellipse') el.style.borderRadius = '50%';
    else if (g === 'roundRect') el.style.borderRadius = Math.min(b.w, b.h) / EMU_PX * .1667 + 'px';
    else if (CLIP[g]) el.style.clipPath = CLIP[g];
  }

  function line(spPr, style, ctx) {
    const ln = kid(spPr, 'ln');
    if (ln && kid(ln, 'noFill')) return null;
    let c = ln && color(kid(ln, 'solidFill'), ctx);
    if (!c && !(ln && kid(ln, 'solidFill'))) {
      const ref = kid(style, 'lnRef');
      if (ref && num(ref, 'idx', 0) > 0) c = color(ref, ctx);
    }
    if (!c) return null;
    const w = Math.max(1, num(ln, 'w', 12700) / EMU_PX);
    const dash = ln && kid(ln, 'prstDash');
    return { color: c, width: w, dashed: dash && dash.getAttribute('val') !== 'solid' };
  }

  // ---------- texto ----------
  function textChain(node, ctx, layoutPh, masterPh) {
    const own = kid(kid(node, 'txBody'), 'lstStyle');
    const info = phInfo(node);
    if (!info) return { lists: [own, ctx.defaultTextStyle], bodies: [] };
    const lp = layoutPh && kid(kid(layoutPh, 'txBody'), 'lstStyle');
    const mp = masterPh && kid(kid(masterPh, 'txBody'), 'lstStyle');
    const tx = ctx.master.txStyles;
    const kind = TITLE_TYPES.has(info.type) ? 'titleStyle'
      : ['body', 'subTitle', 'obj'].includes(info.type) ? 'bodyStyle' : 'otherStyle';
    return {
      lists: [own, lp, mp, kid(tx, kind)],
      bodies: [layoutPh, masterPh].map(n => kid(kid(n, 'txBody'), 'bodyPr'))
    };
  }

  const pick = (els, fn) => { for (const e of els) { if (!e) continue; const v = fn(e); if (v != null) return v; } return null; };

  function fontFamily(face, ctx) {
    if (!face) return null;
    if (face.startsWith('+mj')) face = ctx.theme.major;
    else if (face.startsWith('+mn')) face = ctx.theme.minor;
    return face ? `"${face}", "Segoe UI", Arial, sans-serif` : null;
  }

  // rPrs: [rPr del run, defRPr del lstStyle propio, …herencia]. refColor (fontRef de la forma) va después de los dos primeros.
  function runStyle(span, rPrs, ctx, scale, defColor, refColor) {
    const sz = pick(rPrs, e => e.getAttribute('sz'));
    span.style.fontSize = ((sz ? +sz / 100 : 18) * scale * 96 / 72).toFixed(2) + 'px';
    const b = pick(rPrs, e => e.getAttribute('b'));
    if (b === '1' || b === 'true') span.style.fontWeight = '700';
    const i = pick(rPrs, e => e.getAttribute('i'));
    if (i === '1' || i === 'true') span.style.fontStyle = 'italic';
    const u = pick(rPrs, e => e.getAttribute('u'));
    if (u && u !== 'none') span.style.textDecoration = 'underline';
    const fillOf = e => color(kid(e, 'solidFill'), ctx);
    span.style.color = pick(rPrs.slice(0, 2), fillOf) || refColor || pick(rPrs.slice(2), fillOf) || defColor;
    const ff = pick(rPrs, e => kid(e, 'latin') && fontFamily(kid(e, 'latin').getAttribute('typeface'), ctx));
    if (ff) span.style.fontFamily = ff;
    const baseline = pick(rPrs, e => e.getAttribute('baseline'));
    if (baseline && +baseline) { span.style.verticalAlign = +baseline > 0 ? 'super' : 'sub'; span.style.fontSize = 'smaller'; }
    return sz ? +sz / 100 * scale : 18 * scale;
  }

  function renderText(txBody, chain, ctx, defFont, defColor, refColor) {
    const bodyPr = kid(txBody, 'bodyPr');
    const bodies = [bodyPr, ...chain.bodies];
    const autofit = kid(bodyPr, 'normAutofit');
    const scale = autofit ? num(autofit, 'fontScale', 100000) / 100000 : 1;
    const lnRed = autofit ? num(autofit, 'lnSpcReduction', 0) / 100000 : 0;

    const wrap = document.createElement('div');
    const anchor = pick(bodies, e => e.getAttribute('anchor')) || 't';
    const ins = (a, d) => (+(pick(bodies, e => e.getAttribute(a)) ?? d)) / EMU_PX + 'px';
    Object.assign(wrap.style, {
      position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column',
      justifyContent: anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start',
      padding: `${ins('tIns', 45720)} ${ins('rIns', 91440)} ${ins('bIns', 45720)} ${ins('lIns', 91440)}`,
      overflowWrap: 'break-word', fontFamily: defFont, lineHeight: '1.2'
    });
    if (pick(bodies, e => e.getAttribute('wrap')) === 'none') wrap.style.whiteSpace = 'nowrap';

    let hasText = false;
    const counters = {};
    for (const p of kids(txBody, 'p')) {
      const pPr = kid(p, 'pPr');
      const lvl = num(pPr, 'lvl', 0);
      const pPrs = [pPr, ...chain.lists.map(l => kid(l, `lvl${lvl + 1}pPr`))];
      const defRPrs = pPrs.slice(1).map(e => kid(e, 'defRPr'));
      const div = document.createElement('div');

      const algn = pick(pPrs, e => e.getAttribute('algn'));
      div.style.textAlign = { ctr: 'center', r: 'right', just: 'justify', dist: 'justify' }[algn] || 'left';
      const marL = pick(pPrs, e => e.getAttribute('marL'));
      const indent = pick(pPrs, e => e.getAttribute('indent'));
      if (marL) div.style.marginLeft = +marL / EMU_PX + 'px';
      if (indent) div.style.textIndent = +indent / EMU_PX + 'px';
      const lnPct = pick(pPrs, e => { const s = kid(kid(e, 'lnSpc'), 'spcPct'); return s && num(s, 'val', 100000); });
      if (lnPct || lnRed) div.style.lineHeight = (1.2 * ((lnPct || 100000) / 100000) * (1 - lnRed)).toFixed(3);
      const spc = (tag) => pick(pPrs, e => { const s = kid(kid(e, tag), 'spcPts'); return s && num(s, 'val', 0); });
      const bef = spc('spcBef'), aft = spc('spcAft');
      if (bef) div.style.marginTop = (bef / 100 * 96 / 72).toFixed(1) + 'px';
      if (aft) div.style.marginBottom = (aft / 100 * 96 / 72).toFixed(1) + 'px';

      let size = null;
      const runs = Array.from(p.children).filter(c => ['r', 'br', 'fld'].includes(c.localName));
      for (const r of runs) {
        if (r.localName === 'br') { div.append(document.createElement('br')); continue; }
        const text = (kid(r, 't') || {}).textContent || '';
        const span = document.createElement('span');
        span.textContent = text;
        const s = runStyle(span, [kid(r, 'rPr'), ...defRPrs], ctx, scale, defColor, refColor);
        size = size || s;
        if (text.trim()) hasText = true;
        div.append(span);
      }

      // Viñetas
      const bullet = pick(pPrs, e => kid(e, 'buNone') ? 'none' : kid(e, 'buChar') ? kid(e, 'buChar') : kid(e, 'buAutoNum') ? 'auto' : null);
      if (runs.length && bullet && bullet !== 'none') {
        counters[lvl] = (counters[lvl] || 0) + 1;
        const b = document.createElement('span');
        if (bullet === 'auto') b.textContent = counters[lvl] + '. ';
        else { const ch = bullet.getAttribute('char') || '•'; b.textContent = (BULLET_OK.test(ch) ? ch : '•') + ' '; }
        b.style.color = div.firstChild && div.firstChild.style ? div.firstChild.style.color : defColor;
        b.style.fontSize = div.firstChild && div.firstChild.style ? div.firstChild.style.fontSize : '';
        div.prepend(b);
      } else if (bullet === 'none' || !runs.length) {
        counters[lvl] = 0;
      }

      if (!runs.length) {
        // Párrafo vacío: conserva su altura.
        const span = document.createElement('span');
        span.innerHTML = '&nbsp;';
        runStyle(span, [kid(p, 'endParaRPr'), ...defRPrs], ctx, scale, defColor, refColor);
        div.append(span);
      }
      wrap.append(div);
    }
    return hasText ? wrap : null;
  }

  // ---------- elementos ----------
  async function renderSp(node, T, ctx, rels, out, fromLayer) {
    const info = phInfo(node);
    if (fromLayer && info) return; // los marcadores del diseño/patrón no se muestran solos
    const layoutPh = info && !fromLayer ? findPh(ctx.layoutPhs, info, false) : null;
    const masterPh = info && !fromLayer ? findPh(ctx.master.phs, info, true) : null;
    const xfrm = xfrmOf(node) || xfrmOf(layoutPh) || xfrmOf(masterPh);
    const b = xfrm && box(xfrm, T);
    if (!b) return;

    const spPr = kid(node, 'spPr');
    const style = kid(node, 'style');
    const el = document.createElement('div');
    place(el, b);

    let bg = await fill(spPr, ctx, rels);
    if (bg == null) {
      const ref = kid(style, 'fillRef');
      if (ref && num(ref, 'idx', 0) > 0) bg = color(ref, ctx);
    }
    if (bg && bg !== 'none') el.style.background = bg;
    const ln = line(spPr, style, ctx);
    if (ln) el.style.border = `${ln.width}px ${ln.dashed ? 'dashed' : 'solid'} ${ln.color}`;
    geometry(el, spPr, b);
    if (ln || bg) el.style.boxSizing = 'border-box';

    const txBody = kid(node, 'txBody');
    if (txBody) {
      const chain = textChain(node, ctx, layoutPh, masterPh);
      const isTitle = info && TITLE_TYPES.has(info.type);
      const refColor = color(kid(style, 'fontRef'), ctx);
      const defColor = color({ children: [mkScheme('tx1')] }, ctx) || '#000';
      const defFont = fontFamily(isTitle ? '+mj-lt' : '+mn-lt', ctx);
      const t = renderText(txBody, chain, ctx, defFont, defColor, refColor);
      if (t) {
        if (b.flipH || b.flipV) t.style.transform = `${b.flipH ? 'scaleX(-1)' : ''} ${b.flipV ? 'scaleY(-1)' : ''}`;
        el.append(t);
      }
    }
    if (el.style.background || el.style.border || el.childNodes.length) out.append(el);
  }

  // Nodo schemeClr sintético para resolver colores del tema.
  function mkScheme(val) { return { localName: 'schemeClr', getAttribute: k => k === 'val' ? val : null, children: [] }; }

  async function renderPic(node, T, ctx, rels, out, fromLayer) {
    const info = phInfo(node);
    const layoutPh = info && !fromLayer ? findPh(ctx.layoutPhs, info, false) : null;
    const xfrm = xfrmOf(node) || xfrmOf(layoutPh);
    const b = xfrm && box(xfrm, T);
    const blipFill = kid(node, 'blipFill');
    const url = blipFill && await blipUrl(blipFill, ctx, rels);
    if (!b || !url) return;
    const el = document.createElement('div');
    place(el, b);
    el.style.overflow = 'hidden';
    geometry(el, kid(node, 'spPr'), b);
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.draggable = false;
    const src = kid(blipFill, 'srcRect');
    const l = num(src, 'l', 0) / 1e5, t = num(src, 't', 0) / 1e5, r = num(src, 'r', 0) / 1e5, bt = num(src, 'b', 0) / 1e5;
    const fw = 1 - l - r, fh = 1 - t - bt;
    Object.assign(img.style, {
      position: 'absolute', display: 'block', maxWidth: 'none',
      width: (100 / fw).toFixed(3) + '%', height: (100 / fh).toFixed(3) + '%',
      left: (-l / fw * 100).toFixed(3) + '%', top: (-t / fh * 100).toFixed(3) + '%'
    });
    el.append(img);
    out.append(el);
  }

  function renderCxn(node, T, ctx, out) {
    const xfrm = xfrmOf(node);
    const b = xfrm && box(xfrm, T);
    const ln = line(kid(node, 'spPr'), kid(node, 'style'), ctx);
    if (!b || !ln) return;
    const w = b.w / EMU_PX, h = b.h / EMU_PX;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    place(svg, b);
    svg.style.overflow = 'visible';
    svg.setAttribute('viewBox', `0 0 ${Math.max(w, 1)} ${Math.max(h, 1)}`);
    const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', 0); l.setAttribute('y1', 0); l.setAttribute('x2', w); l.setAttribute('y2', h);
    l.setAttribute('stroke', ln.color); l.setAttribute('stroke-width', ln.width);
    if (ln.dashed) l.setAttribute('stroke-dasharray', `${ln.width * 3} ${ln.width * 2}`);
    svg.append(l);
    out.append(svg);
  }

  async function renderFrame(node, T, ctx, rels, out) {
    const b = box(kid(node, 'xfrm'), T);
    if (!b) return;
    const data = path(node, 'graphic', 'graphicData');
    const tbl = kid(data, 'tbl');
    const el = document.createElement('div');
    place(el, b);
    if (!tbl) {
      Object.assign(el.style, { border: '1px dashed rgba(128,128,128,.6)', display: 'grid', placeItems: 'center', color: 'rgba(128,128,128,.9)', font: '14px system-ui' });
      el.textContent = 'Gráfico o diagrama no compatible';
      out.append(el);
      return;
    }
    const table = document.createElement('table');
    Object.assign(table.style, { width: '100%', height: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' });
    const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map(c => num(c, 'w', 0) / EMU_PX);
    const cg = document.createElement('colgroup');
    for (const w of cols) { const c = document.createElement('col'); c.style.width = w + 'px'; cg.append(c); }
    table.append(cg);
    const defColor = color({ children: [mkScheme('tx1')] }, ctx) || '#000';
    const defFont = fontFamily('+mn-lt', ctx);
    for (const tr of kids(tbl, 'tr')) {
      const row = document.createElement('tr');
      row.style.height = num(tr, 'h', 0) / EMU_PX + 'px';
      for (const tc of kids(tr, 'tc')) {
        if (tc.getAttribute('hMerge') === '1' || tc.getAttribute('vMerge') === '1') continue;
        const td = document.createElement('td');
        if (tc.getAttribute('gridSpan')) td.colSpan = +tc.getAttribute('gridSpan');
        if (tc.getAttribute('rowSpan')) td.rowSpan = +tc.getAttribute('rowSpan');
        Object.assign(td.style, { position: 'relative', border: '1px solid rgba(128,128,128,.5)', padding: '0', verticalAlign: 'top' });
        const tcPr = kid(tc, 'tcPr');
        const bg = await fill(tcPr, ctx, rels);
        if (bg && bg !== 'none') td.style.background = bg;
        const txBody = kid(tc, 'txBody');
        const t = txBody && renderText(txBody, { lists: [kid(txBody, 'lstStyle'), ctx.defaultTextStyle], bodies: [] }, ctx, defFont, defColor);
        if (t) { t.style.position = 'static'; td.append(t); }
        row.append(td);
      }
      table.append(row);
    }
    el.append(table);
    out.append(el);
  }

  async function walk(tree, T, ctx, rels, out, fromLayer) {
    for (const node of tree.children) {
      switch (node.localName) {
        case 'sp': await renderSp(node, T, ctx, rels, out, fromLayer); break;
        case 'pic': await renderPic(node, T, ctx, rels, out, fromLayer); break;
        case 'cxnSp': renderCxn(node, T, ctx, out); break;
        case 'graphicFrame': await renderFrame(node, T, ctx, rels, out); break;
        case 'grpSp': {
          const x = xfrmOf(node);
          const off = kid(x, 'off'), ext = kid(x, 'ext'), chOff = kid(x, 'chOff'), chExt = kid(x, 'chExt');
          if (!off || !ext || !chOff || !chExt) { await walk(node, T, ctx, rels, out, fromLayer); break; }
          const kx = num(chExt, 'cx', 1) ? num(ext, 'cx', 0) / num(chExt, 'cx', 1) : 1;
          const ky = num(chExt, 'cy', 1) ? num(ext, 'cy', 0) / num(chExt, 'cy', 1) : 1;
          const inner = {
            sx: T.sx * kx, sy: T.sy * ky,
            tx: (num(off, 'x', 0) - num(chOff, 'x', 0) * kx) * T.sx + T.tx,
            ty: (num(off, 'y', 0) - num(chOff, 'y', 0) * ky) * T.sy + T.ty
          };
          await walk(node, inner, ctx, rels, out, fromLayer);
          break;
        }
        case 'AlternateContent': {
          const fb = kid(node, 'Fallback') || kid(node, 'Choice');
          if (fb) await walk(fb, T, ctx, rels, out, fromLayer);
          break;
        }
      }
    }
  }

  // ---------- API pública ----------
  async function open(buffer) {
    if (!window.JSZip) throw new Error('No se cargó JSZip.');
    let zip;
    try { zip = await JSZip.loadAsync(buffer); } catch { throw new Error('El archivo no es un .pptx válido.'); }
    const pkg = { zip, xml: {}, media: new Map(), masters: {}, urls: [] };
    const presPath = 'ppt/presentation.xml';
    const pres = await readXml(pkg, presPath);
    if (!pres) throw new Error('El archivo no es un .pptx válido.');
    const sz = first(pres, 'sldSz');
    const width = num(sz, 'cx', 9144000) / EMU_PX, height = num(sz, 'cy', 6858000) / EMU_PX;
    const presRels = await readRels(pkg, presPath);
    const slides = [];
    for (const s of kids(first(pres, 'sldIdLst'), 'sldId')) {
      const r = presRels[rid(s, 'id')];
      if (r) slides.push(r.target);
    }
    const defaultTextStyle = first(pres, 'defaultTextStyle');
    const cache = new Map();

    async function render(i) {
      if (cache.has(i)) return cache.get(i);
      const job = (async () => {
        const slidePath = slides[i];
        const doc = await readXml(pkg, slidePath);
        const rels = await readRels(pkg, slidePath);
        const layoutPath = relOfType(rels, 'slideLayout').target;
        const layoutDoc = await readXml(pkg, layoutPath);
        const layoutRels = await readRels(pkg, layoutPath);
        const master = await loadMaster(pkg, relOfType(layoutRels, 'slideMaster').target);
        const ctx = {
          pkg, master, theme: master.theme, clrMap: master.clrMap,
          layoutPhs: placeholders(layoutDoc), defaultTextStyle
        };

        const el = document.createElement('div');
        Object.assign(el.style, { position: 'absolute', inset: '0', overflow: 'hidden', background: '#fff' });
        const root = doc.documentElement;
        const cSld = kid(root, 'cSld'), lcSld = kid(layoutDoc.documentElement, 'cSld'), mcSld = kid(master.doc.documentElement, 'cSld');
        el.style.background = (await background(cSld, ctx, rels)) ||
          (await background(lcSld, ctx, layoutRels)) ||
          (await background(mcSld, ctx, master.rels)) || '#fff';

        const T = { sx: 1, sy: 1, tx: 0, ty: 0 };
        const showMaster = root.getAttribute('showMasterSp') !== '0';
        if (showMaster && layoutDoc.documentElement.getAttribute('showMasterSp') !== '0') {
          await walk(kid(mcSld, 'spTree'), T, ctx, master.rels, el, true);
        }
        if (showMaster) await walk(kid(lcSld, 'spTree'), T, ctx, layoutRels, el, true);
        await walk(kid(cSld, 'spTree'), T, ctx, rels, el, false);
        return el;
      })();
      cache.set(i, job);
      job.catch(() => cache.delete(i));
      return job;
    }

    function close() {
      for (const u of pkg.urls) URL.revokeObjectURL(u);
      pkg.urls.length = 0;
      cache.clear();
    }

    return { width, height, count: slides.length, render, close };
  }

  window.Pptx = { open };
})();
