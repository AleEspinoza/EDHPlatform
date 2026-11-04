# EDH Platform — próximos pasos

Lo que sigue, en orden de prioridad. Los primeros tres juntos dejan la plataforma publicada, con cuentas que no se borran y entrada con Google.

## Pendientes prioritarios (de Alejandro)

El código ya está listo; esto solo lo puedes hacer tú, porque las cuentas deben quedar a tu nombre. Las claves se pegan en el panel de Render y en tu `.env` local, nunca en el repo.

- [ ] **Turso:** crear cuenta en turso.tech (con GitHub), crear una base y copiar su URL y un token
- [ ] **Google:** crear las credenciales en Google Cloud (pasos en la sección 2). Agregar como redirect `https://edhplatform.onrender.com/api/auth/google/callback`
- [ ] **Render:** en **Environment**, cargar `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`
- [ ] **Cuenta de prueba (opcional):** en Render, `DEMO_USER=adm` y `DEMO_PASSWORD` con la contraseña que quieras. Se crea sola al arrancar
- [ ] **Comprobar:** abrir `https://edhplatform.onrender.com/health` y ver `"db":"turso"`

## 1. Que las cuentas persistan (base de datos externa)

**El problema:** hoy las cuentas, mazos e historial viven en un archivo SQLite dentro del servidor. En local se conservan, pero en Render gratis el disco se borra cada vez que el servidor se duerme (tras 15 minutos sin uso) o se redespliega. Publicado así, los jugadores tendrían que volver a crear su cuenta en cada sesión.

**La solución:** la base vive en **Turso**, un servicio compatible con SQLite con plan gratis que guarda los datos fuera del servidor.

| Paso | Quién | Estado |
| --- | --- | --- |
| Adaptar el código al cliente de Turso (`@libsql/client`) | Claude | Hecho (v0.10). Sin las variables se usa un archivo local |
| Crear cuenta y base en turso.tech | Alejandro | Pendiente: entrar con GitHub, crear una base, copiar su URL y crear un token |
| Cargar `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` | Alejandro | Pendiente: en el panel de Render y, para probar en local, en `.env` |

**Las claves nunca van al repo.** `render.yaml` solo declara los nombres (`sync: false`) y Render pide los valores en su panel. En local van en `.env`, que está en `.gitignore`; `.env.example` muestra qué llenar.

La alternativa es Neon (Postgres gratis), que exige reescribir más consultas. Un disco persistente en Render requiere el plan pagado.

## 2. Activar «Continuar con Google»

**Ya está programado y probado** con Google simulado (PKCE, validación del token, creación y reutilización de la cuenta). Falta solo crear las credenciales, que deben salir de tu cuenta de Google:

1. En [Google Cloud Console](https://console.cloud.google.com/apis/credentials), crear un proyecto y configurar la pantalla de consentimiento OAuth (tipo externo; alcances `openid`, `email` y `profile`).
2. Crear un **ID de cliente OAuth → Aplicación web** con estos URI de redireccionamiento:
   - `http://localhost:3000/api/auth/google/callback` (pruebas en local)
   - `https://<tu-app>.onrender.com/api/auth/google/callback` (cuando esté publicada)
3. Poner `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en el panel de Render y en tu `.env` local (nunca en el código). El botón aparece solo.
4. Mientras la app esté en modo «Prueba» en Google, solo entran los correos agregados como usuarios de prueba. Para abrirla a cualquiera, se publica la app en la pantalla de consentimiento.

Sin el paso 1, Google funciona pero las cuentas creadas con Google también se borran en Render.

## 3. Publicar en Render

`render.yaml` ya está en el repo. En render.com: entrar con GitHub → **New → Blueprint** → elegir `EDHPlatform` → confirmar. Cada `git push` vuelve a desplegar. La primera visita después de 15 minutos sin uso tarda alrededor de un minuto en despertar el servidor.

## 4. Paridad con EDHPlay que falta

- Opciones de sala: formato, sala pública o privada, número de asientos, botón «listo», expulsar jugadores
- Espectadores
- Validación de mazos por formato y estimación de bracket (1–5)
- Elegir la edición de cada carta
- Atajo «Agregar a la pila» (`K` en EDHPlay)
- Recuperar contraseña (requiere envío de correos)

## 5. Arte pendiente

Los prompts están en el documento «Prompts de arte para EDH Platform».

- Reverso de carta propio
- Gema de vida
- Pila de cartas del mazo, sin el logo de Hearthstone

## 6. Jugar contra una IA (prioridad media, en etapa de idea)

**Premisa:** practicar cEDH contra una IA. En vez de un motor de reglas, un **agente** con un modelo de lenguaje actual, con las herramientas y skills adecuadas, que tome decisiones parecidas a las de un jugador competitivo. Todavía es una idea para iterar, no un plan comprometido.

**Por qué puede funcionar en cEDH:** el metajuego es estrecho y las líneas de victoria están documentadas, así que el agente pilota un mazo con un plan explícito. Además, el modelo lee el texto de las cartas y el servidor ya filtra la información oculta, de modo que el agente ve lo mismo que un humano.

**Riesgos:** cálculo exacto (maná, storm, combos) → se resuelve con herramientas; no hay pila ni prioridad formal en la mesa; latencia y costo por cada ventana de respuesta → se resuelve con un filtro que solo despierta al modelo cuando importa; reglas raras (capas, reemplazos).

**Cómo se armaría:**

| Pieza | Qué es |
| --- | --- |
| Pila y prioridad en el motor | Lanzar «a la pila», pasar prioridad, resolver. También cierra la paridad con EDHPlay (el atajo `K`) y sirve a los humanos |
| Herramientas del agente | Leer el estado, leer el texto de una carta y las mismas acciones de un humano (robar, girar, lanzar, mover), más «responder» y «pasar» |
| Calculadora de combos y maná | Código que responde «¿puedo ganar ahora con esto?» y «¿qué secuencia me deja el maná justo?» para las líneas del mazo |
| Skill por mazo | El plan escrito del mazo: líneas de victoria, criterios de mulligan, qué interacción guardar y para qué, cuándo ser el que frena a la mesa |
| Bucle del agente en el servidor | Usa la API de Claude con esas herramientas. Requiere una clave de API y cada partida tiene un costo |
| Registro de decisiones | Cada decisión con su razonamiento, para evaluar si jugó como un jugador competitivo y ajustar la skill |

**Por dónde partir:** 1 contra 1 contra un agente que pilota un solo mazo de cEDH. Después, mesa de 4 con tres agentes (tres veces el costo, más juego político).

**Expectativa:** con la calculadora y una buena skill, un jugador competente que conoce bien su mazo; le costará leer la mano rival y las decisiones finas de mesa.

**Preguntas abiertas:** qué mazo pilota primero el agente; si practicas con tu mazo contra él o lo miras jugar para aprender las líneas.

Alternativas descartadas por ahora: integrar la IA de Forge (reglas correctas pero juego mediocre, licencia GPL) y un motor de reglas propio con búsqueda (años de trabajo).

## 7. Moxfield

Escribir a support@moxfield.com describiendo la app y pidiendo un User-Agent autorizado. Con ese valor en `MOXFIELD_USER_AGENT`, el importador por link se activa solo.
