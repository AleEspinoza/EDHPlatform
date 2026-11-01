# EDH Platform

Versión 0.8

Mesa virtual de Commander/EDH con salas privadas, mazos importados y todas las acciones del juego en tiempo real.

## Qué incluye

- **Estilo «Taberna»** (dirección Hearthstone): tapetes enmarcados sobre una mesa de taberna, marco de héroe con la gema de vida, zonas enmarcadas abajo a la derecha (mazo, cementerio, exilio, uno o dos comandantes), placa de «Pasar turno», bandeja de la mano con faroles y carteles de cómic animados para Trigger, Respondo, Espera, OK y Tu turno. Tipografía Bree Serif + Nunito.

- **Salas privadas** con código de 6 caracteres y enlace de invitación (`/?sala=CODIGO`), hasta 6 jugadores.
- **Reconexión**: si recargas o se cae la conexión, vuelves a tu asiento con tus cartas.
- **Cuenta obligatoria para jugar**: entra con Google o con usuario y contraseña. En tu inicio están tus mazos, tus partidas pasadas y tus estadísticas (récord, % de victorias, turnos y duración media, y resultados por comandante).
- **Terminar partida** eligiendo al ganador (o empate), con revancha opcional; queda en el historial de cada jugador. Si la sala se cierra a mitad de partida, se guarda como «sin terminar».
- **Mazos guardados**: créalos desde el inicio o al cargarlos en una sala; jugar uno es un clic, sin volver a consultar Scryfall.
- **Atajos idénticos a EDHPlay** y reasignables (tecla `I` o botón ⌨): `Espacio` pasar turno, `D` robar, `U` enderezar, `Q` avanzar fase, `M` maná, `V` ver biblioteca, `P`/`Shift+P` ver tope/fondo, `O` moneda, `N` ficha; sobre una carta `T` girar, `A` al campo, `G` cementerio, `E` exilio, `H` mano, `L`/`B` tope/fondo, `Z` boca abajo, `F` voltear, `X` copia, `W` flecha, `+`/`_` contadores, `Alt+1..4` fuerza/resistencia; `1–6` enfocar jugador y `7–0` reacciones.
- **Tapetes a elección**: cada jugador elige el suyo (imagen o uno de 15 colores planos) y todos lo ven; se recuerda entre partidas. Para agregar imágenes basta dejarlas en `public/assets/mats/`.
- **Enviar cartas a otros jugadores**: arrastrándolas a su campo, mano (✋), cementerio, exilio o biblioteca, o con «Enviar a…»; siguen siendo tuyas como dueño.
- **Selección múltiple** (Shift+clic o `Ctrl+A`), **flechas** desde una carta hacia otra carta, una zona (incluida la mano), un jugador o cualquier punto de la mesa, **fases** del turno, **rastreador de maná** y **modificadores +X/+Y**.
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
- **Atajos**: lista completa y reasignable con `I` (por defecto los de EDHPlay). Principales: `Espacio` pasar turno · `D` robar · `U` enderezar todo · `R` respondo · `G` trigger · sobre una carta: `T` girar, `P` jugar, `F` boca abajo, `+`/`-` contadores, `Supr` cementerio.

## Arte

Las imágenes viven en `public/assets/` (`.webp` o `.png`) y son opcionales: el servidor publica la lista en `/assets-manifest.json` y la interfaz usa un respaldo dibujado con CSS para lo que falte. Los prompts para generar el resto están en el documento «Prompts de arte para EDH Platform».

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
