# EDH Platform

Versión 0.4

Mesa virtual de Commander/EDH con salas privadas, mazos importados y todas las acciones del juego en tiempo real.

## Qué incluye

- **Salas privadas** con código de 6 caracteres y enlace de invitación (`/?sala=CODIGO`), hasta 6 jugadores.
- **Reconexión**: si recargas o se cae la conexión, vuelves a tu asiento con tus cartas.
- **Cuentas**: usuario y contraseña (opcional) para guardar mazos; jugar un mazo guardado es un clic, sin volver a consultar Scryfall. Editar un mazo lo actualiza en vez de duplicarlo.
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

### Sobre Moxfield

Moxfield no tiene API pública ni login para apps externas, y sus términos prohíben el scraping sin autorización. Para activar la importación por link hay que escribir a **support@moxfield.com**, describir la app y pedir un User-Agent autorizado; ese valor va en `MOXFIELD_USER_AGENT`. Sin él, el botón queda desactivado y la app indica cómo exportar el texto desde Moxfield.

## Controles

- **Arrastrar** entre mano, campo y zonas. Si sueltas sobre la biblioteca queda al tope; con Shift, al fondo.
- **Clic** en una carta del campo la gira. **Doble clic** en la mano la juega.
- **Clic derecho** en una carta, la biblioteca o el campo abre todas las acciones.
- **Atajos**: `D` robar · `U` enderezar todo · `R` respondo · `G` trigger · con el mouse sobre una carta: `T` girar, `F` boca abajo, `+`/`-` contadores.

## Arquitectura

```
server/game.js   Motor puro: estado autoritativo, acciones validadas y vista filtrada por jugador
server/index.js  Express + Socket.IO: salas, códigos, reconexión por token, difusión de estado
server/api.js    REST: cuentas, mazos guardados e importación
server/auth.js   scrypt, sesiones por cookie httpOnly, límite de intentos
server/db.js     Esquema SQLite (usuarios, sesiones, mazos)
server/moxfield.js  Importador de Moxfield (requiere autorización)
public/          Cliente sin build step (ES modules): lobby, tablero, menús, importación de mazos
test/            node:test — motor y partida multijugador por sockets
```

El servidor es la única fuente de verdad. El cliente solo envía intenciones (`{type: 'move', iid, to}`) y recibe la vista de la sala que le corresponde. Las salas viven en memoria y se borran tras 6 h sin actividad.

## Próximos pasos sugeridos

- Persistir también las partidas en curso para que sobrevivan a un reinicio.
- Recuperación de contraseña (requiere correo) o login con Discord/Google.
- Importar por link de Archidekt (tiene API pública).
- Selección múltiple y arrastre en grupo, flechas de objetivo y fases del turno.
- Cuentas, mazos guardados y matchmaking por nivel de poder (bracket).
