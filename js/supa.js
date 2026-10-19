// Cliente de Supabase compartido por todas las páginas de la app.
(function () {
  const cfg = window.EXPO_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || cfg.supabaseUrl.includes('TU-PROYECTO')) {
    document.addEventListener('DOMContentLoaded', () => {
      document.body.innerHTML =
        '<main class="center"><section class="box"><h1>Falta configuración</h1>' +
        '<p>Copia <code>app/js/config.example.js</code> como <code>app/js/config.js</code> y completa tus claves.</p></section></main>';
    });
    throw new Error('EXPO_CONFIG incompleto');
  }

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  // Redirige al login si no hay sesión. Nunca resuelve en ese caso.
  async function requireSession() {
    const { data } = await sb.auth.getSession();
    if (!data.session) {
      location.replace('index.html');
      return new Promise(() => {});
    }
    return data.session;
  }

  function authError(err) {
    const m = ((err && err.message) || '').toLowerCase();
    if (m.includes('invalid login')) return 'Correo o contraseña incorrectos.';
    if (m.includes('already registered')) return 'Ese correo ya tiene una cuenta.';
    if (m.includes('not confirmed')) return 'Confirma tu correo antes de ingresar.';
    if (m.includes('rate limit') || m.includes('security purposes')) return 'Demasiados intentos. Espera unos minutos.';
    if (m.includes('password')) return 'La contraseña no cumple los requisitos (mínimo 8 caracteres).';
    if (m.includes('email')) return 'El correo no es válido.';
    if (m.includes('fetch')) return 'No se pudo conectar con el servidor.';
    return (err && err.message) || 'Error inesperado.';
  }

  window.Expo = { sb, cfg, requireSession, authError };
})();
