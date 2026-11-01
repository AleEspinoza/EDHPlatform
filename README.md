# EDH Platform

Versión 0.6

Mesa virtual de Commander/EDH con salas privadas, mazos importados y todas las acciones del juego en tiempo real.

## Qué incluye

- **Estilo «Mesa del Archivo»**: mano en abanico que se levanta al pasar el mouse, retratos con el arte del comandante, gema de vida, cartas que caen al campo al jugarse y banner de turno.

- **Salas privadas** con código de 6 caracteres y enlace de invitación (`/?sala=CODIGO`), hasta 6 jugadores.
- **Reconexión**: si recargas o se cae la conexión, vuelves a tu asiento con tus cartas.
- **Cuenta obligatoria para jugar**: entra con Google o con usuario y contraseña. En tu inicio están tus mazos, tus partidas pasadas y tus estadísticas (récord, % de victorias, turnos y duración media, y resultados por comandante).
- **Terminar partida** eligiendo al ganador (o empate), con revancha opcional; queda en el historial de cada jugador. Si la sala se cierra a mitad de partida, se guarda como «sin terminar».
- **Mazos guardados**: créalos desde el inicio o al cargarlos en una sala; jugar uno es un clic, sin volver a consultar Scryfall.
- **Atajos de teclado reasignables** (tecla `K` o botón ⌨): `Espacio` pasa el turno, `D` roba, `U` endereza todo y acciones sobre la carta bajo el mouse (`T` girar, `P` jugar, `Supr` cementerio, `E` exilio, `H` mano, `A` tope de biblioteca…).
- **Importar desde Moxfield por link** (apagado por defecto; ver abajo).
- **Importar mazo** pegando la lista (Moxfield, Archidekt, MTGO: `1 Sol Ring (C21) 263`). Imágenes desde Scryfall, cartas de dos caras con transformar.
- **Zonas**: biblioteca, mano, campo de batalla, cementerio, exilio y zona de mando.
- **Acciones**: robar, moler, barajar, mulligan, girar/enderezar, enderezar todo, boca abajo, transformar, contadores, tokens y copias, mover al tope o fondo de la biblioteca, mirar el tope X, buscar en la biblioteca, revelar carta o mano.
- **Adjuntar** auras y equipos a cualquier permanente (tuyo o rival); el adjunto se dibuja bajo su anfitrión y se suelta si este deja el campo.
- **Cambio de control**: entrega un permanente a otro jugador; al dejar el campo vuelve a las zonas de su dueño, y queda marcado con su color.
- **Tokens**: buscador de tokens de Scryfall con imagen, tokens que crea cada carta (desde su menú) y tokens de texto libre.
- **Ficha de carta**: texto oráculo, legalidad en Commander y rulings desde Scryfall, también para cartas de rivales.
- **Zonas rivales**: moler, exiliar o revelar el tope de su biblioteca, descarte al azar y pedirle que revele la mano (todo queda en el log).
- **Práctica en solitario (goldfish)**: sala privada solo tuya, con «+ Asiento» para agregar tableros que controlas (con tu mazo u otro) y pestañas para manejar la mano de cada asiento.
- **Marcadores**: vida (40), veneno y daño de comandante por rival (descuenta vida y marca letal a 21).
- **Mesa compartida**: turnos, log de la partida y chat.
- **Anuncios animados** para toda la mesa: ✋ Respondo, ⚡ Tengo un trigger (opcionalmente mostrando la carta), ⏸ Espera y ✓ OK, con sonido.
- **Comandos de chat**: `/moneda`, `/dado`, `/d6`, `/dado 2d6`, `/respondo`, `/trigger`, `/espera`, `/ok`, `/robar 2`, `/enderezar`, `/barajar`, `/vida -3`, `/ayuda`. Moneda y dados se animan para todos.
- **Información oculta en el servidor**: la mano y la biblioteca ajenas nunca llegan al navegador de los rivales, y tampoco las cartas boca abajo.

## Cómo correrlo

Requiere Node.js 22.13 o superior (usa el SQLite integrado de Node; la base queda en `data/edhplatform.db`).

```bash
npm install
npm start          # http://localhost:3000
npm test           # motor de juego + partida por sockets
```

Para jugar con amigos fuera de tu red, despliega en cualquier hosting de Node con WebSockets (Render, Railway, Fly.io) o expón tu puerto local con un túnel (`cloudflared tunnel --url http://localhost:3000`).

### Variables de entorno

| Variable | Para qué |
|---|---|
| `PORT` | Puerto HTTP (3000 por defecto) |
| `DB_FILE` | Ruta de la base SQLite (por defecto `data/edhplatform.db`) |
| `NODE_ENV=production` | Cookies de sesión con `Secure` (requiere HTTPS) |
| `TRUST_PROXY=1` | Detrás de un proxy (Render, Railway, Fly) |
| `MOXFIELD_USER_AGENT` | Activa la importación por link de Moxfield |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Activan «Continuar con Google» |
| `GOOGLE_REDIRECT_URI` | Opcional: fija el redirect (por defecto `https://<tu-host>/api/auth/google/callback`) |

### Iniciar sesión con Google

1. En [Google Cloud Console](https://console.cloud.google.com/apis/credentials) crea un proyecto y configura la **pantalla de consentimiento OAuth** (tipo externo; alcances `openid`, `email` y `profile`).
2. Crea una credencial **ID de cliente OAuth → Aplicación web** y agrega como URI de redireccionamiento autorizado `http://localhost:3000/api/auth/google/callback` (y el de tu dominio cuando lo despliegues).
3. Arranca con `GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm start`. Sin esas variables el botón de Google no aparece y se entra con usuario y contraseña.

### Sobre Moxfield

Moxfield no tiene API pública ni login para apps externas, y sus términos prohíben el scraping sin autorización. Para activar la importación por link hay que escribir a **support@moxfield.com**, describir la app y pedir un User-Agent autorizado; ese valor va en `MOXFIELD_USER_AGENT`. Sin él, el botón queda desactivado y la app indica cómo exportar el texto desde Moxfield.

## Controles

- **Arrastrar** entre mano, campo y zonas. Si sueltas sobre la biblioteca queda al tope; con Shift, al fondo.
- **Clic** en una carta del campo la gira. **Doble clic** en la mano la juega.
- **Clic derecho** en una carta, la biblioteca o el campo abre todas las acciones.
- **Atajos**: lista completa y reasignable con `K`. Principales: `Espacio` pasar turno · `D` robar · `U` enderezar todo · `R` respondo · `G` trigger · sobre una carta: `T` girar, `P` jugar, `F` boca abajo, `+`/`-` contadores, `Supr` cementerio.

## Arquitectura

```
server/game.js   Motor puro: estado autoritativo, acciones validadas y vista filtrada por jugador
server/index.js  Express + Socket.IO: salas, códigos, reconexión por token, difusión de estado
server/api.js    REST: cuentas, mazos guardados e importación
server/auth.js   scrypt, sesiones por cookie httpOnly, límite de intentos
server/db.js     Esquema SQLite (usuarios, sesiones, mazos, partidas) y migraciones
server/google.js Login con Google (OAuth 2.0 con PKCE)
server/history.js Historial de partidas y estadísticas
server/moxfield.js  Importador de Moxfield (requiere autorización)
public/          Cliente sin build step (ES modules): lobby, tablero, menús, importación de mazos
test/            node:test — motor y partida multijugador por sockets
```

El servidor es la única fuente de verdad. El cliente solo envía intenciones (`{type: 'move', iid, to}`) y recibe la vista de la sala que le corresponde. Las salas viven en memoria y se borran tras 6 h sin actividad.

## Próximos pasos sugeridos

- Persistir también las partidas en curso para que sobrevivan a un reinicio.
- Recuperación de contraseña (requiere correo) y login con Discord.
- Importar por link de Archidekt (tiene API pública).
- Selección múltiple y arrastre en grupo, flechas de objetivo y fases del turno.
- Matchmaking por nivel de poder (bracket).
