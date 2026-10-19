<h1 align="center">AI-EXPO · Presentación con control remoto en tiempo real</h1>

<p align="center">
Presentación web de 7 láminas para proponer un piloto de IA de 90 días, con <b>control remoto desde el celular</b>,<br>
guion del expositor, cronómetro por lámina y sincronización en vivo entre dispositivos vía <b>Supabase Realtime</b>.
</p>

<p align="center">
<a href="https://annthoq.github.io/AI-EXPO/"><b>Ver demo</b></a> ·
<a href="https://annthoq.github.io/AI-EXPO/?local">Modo local (sin backend)</a>
</p>

---

## El problema que resuelve

Exponer frente a un comité suele exigir un clicker, un segundo monitor o alguien que pase las láminas. AI-EXPO convierte cualquier navegador en la pantalla de proyección y cualquier celular en el **panel del expositor**: avanza láminas, ve el guion y los tiempos objetivo, y despliega detalles en la pantalla del público, todo sincronizado en menos de un segundo y sin instalar nada.

## Demo

<!-- Sustituye por una captura o GIF real: docs/demo.gif -->
<p align="center"><img src="docs/demo.gif" width="720" alt="Proyección y panel remoto sincronizados"></p>

| Vista | URL |
|---|---|
| Proyección (público) | `https://annthoq.github.io/AI-EXPO/` |
| Panel del expositor | `https://annthoq.github.io/AI-EXPO/?admin` |
| Sin backend (offline) | `https://annthoq.github.io/AI-EXPO/?local` |

## Tech Stack

| Capa | Tecnología |
|---|---|
| Frontend | HTML5, CSS3 (unidades `vmin`, responsive), JavaScript ES2020 sin frameworks |
| Tiempo real | [Supabase](https://supabase.com) — Postgres Changes + canales Broadcast |
| Seguridad | Función RPC `set_slide` que valida la clave del expositor en el servidor |
| Tipografía | Google Fonts (Bricolage Grotesque) |
| Hosting | GitHub Pages |

## Características

- **Control remoto:** el panel `?admin` (protegido con clave) mueve la lámina en todas las pantallas conectadas.
- **Sincronización en vivo:** la lámina actual se guarda en la tabla `slideshow_state` y se propaga con `postgres_changes`; los detalles desplegables viajan por un canal *broadcast*.
- **Guía de exposición:** guion por lámina, recurso retórico (ethos, pathos, logos), indicaciones escénicas y tiempo objetivo (5 min en total).
- **Cronómetro** con inicio, pausa y reinicio.
- **Preguntas probables del comité** con respuestas preparadas.
- **Navegación por teclado:** `←` / `→` y `Espacio`.
- **Modo local** (`?local`): funciona sin Supabase para ensayar o exponer sin conexión.

## Instalación y ejecución local

```bash
git clone https://github.com/AnnthoQ/AI-EXPO.git
cd AI-EXPO
python -m http.server 8080      # o: npx serve .
```

Abre `http://localhost:8080/?local` para usarla sin backend.

### Conectar tu propio Supabase (opcional)

1. Crea un proyecto en Supabase.
2. Crea la tabla `slideshow_state` (columna `current_slide`) y la función `set_slide(p_pin, p_slide)` que verifique la clave antes de actualizar.
3. Activa Realtime sobre `slideshow_state`.
4. Reemplaza `SUPABASE_URL` y `SUPABASE_ANON_KEY` al inicio del `<script>` de `index.html`.

> La *anon key* es pública por diseño; la clave del expositor nunca se guarda en el cliente, se valida en la función RPC.

## Arquitectura

```
AI-EXPO/
├── index.html                          # App completa: láminas, estilos, guion y lógica
├── Presentacion_90dias_desplegada.pptx # Versión PowerPoint de la presentación
└── TA1_PomaRoy.docx                    # Documento de la tarea asociada
```

```
 Celular (?admin)  ──rpc set_slide──▶  Supabase (Postgres)
                                          │ postgres_changes / broadcast
                                          ▼
 Proyector (/)  ◀────────────── actualización en tiempo real
```

## Licencia y contacto

Distribuido bajo licencia [MIT](LICENSE). Hecho por [@AnnthoQ](https://github.com/AnnthoQ).
