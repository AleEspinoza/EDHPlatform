# EDH Platform

Versión 0.2

Mesa virtual de Commander/EDH con salas privadas, mazos importados y todas las acciones del juego en tiempo real.

## Qué incluye

- **Salas privadas** con código de 6 caracteres y enlace de invitación (`/?sala=CODIGO`), hasta 6 jugadores.
- **Reconexión**: si recargas o se cae la conexión, vuelves a tu asiento con tus cartas.
- **Importar mazo** pegando la lista (Moxfield, Archidekt, MTGO: `1 Sol Ring (C21) 263`). Imágenes desde Scryfall, cartas de dos caras con transformar.
- **Zonas**: biblioteca, mano, campo de batalla, cementerio, exilio y zona de mando.
- **Acciones**: robar, moler, barajar, mulligan, girar/enderezar, enderezar todo, boca abajo, transformar, contadores, tokens y copias, mover al tope o fondo de la biblioteca, mirar el tope X, buscar en la biblioteca, revelar carta o mano.
- **Marcadores**: vida (40), veneno y daño de comandante por rival (descuenta vida y marca letal a 21).
- **Mesa compartida**: turnos, log de la partida y chat.
- **Anuncios animados** para toda la mesa: ✋ Respondo, ⚡ Tengo un trigger (opcionalmente mostrando la carta), ⏸ Espera y ✓ OK, con sonido.
- **Comandos de chat**: `/moneda`, `/dado`, `/d6`, `/dado 2d6`, `/respondo`, `/trigger`, `/espera`, `/ok`, `/robar 2`, `/enderezar`, `/barajar`, `/vida -3`, `/ayuda`. Moneda y dados se animan para todos.
- **Información oculta en el servidor**: la mano y la biblioteca ajenas nunca llegan al navegador de los rivales, y tampoco las cartas boca abajo.

## Cómo correrlo

Requiere Node.js 18 o superior.

```bash
npm install
npm start          # http://localhost:3000
npm test           # motor de juego + partida por sockets
```

Para jugar con amigos fuera de tu red, despliega en cualquier hosting de Node con WebSockets (Render, Railway, Fly.io) o expón tu puerto local con un túnel (`cloudflared tunnel --url http://localhost:3000`).

## Controles

- **Arrastrar** entre mano, campo y zonas. Si sueltas sobre la biblioteca queda al tope; con Shift, al fondo.
- **Clic** en una carta del campo la gira. **Doble clic** en la mano la juega.
- **Clic derecho** en una carta, la biblioteca o el campo abre todas las acciones.
- **Atajos**: `D` robar · `U` enderezar todo · `R` respondo · `G` trigger · con el mouse sobre una carta: `T` girar, `F` boca abajo, `+`/`-` contadores.

## Arquitectura

```
server/game.js   Motor puro: estado autoritativo, acciones validadas y vista filtrada por jugador
server/index.js  Express + Socket.IO: salas, códigos, reconexión por token, difusión de estado
public/          Cliente sin build step (ES modules): lobby, tablero, menús, importación de mazos
test/            node:test — motor y partida multijugador por sockets
```

El servidor es la única fuente de verdad. El cliente solo envía intenciones (`{type: 'move', iid, to}`) y recibe la vista de la sala que le corresponde. Las salas viven en memoria y se borran tras 6 h sin actividad.

## Próximos pasos sugeridos

- Persistencia (Redis/Postgres) para que las salas sobrevivan a un reinicio.
- Importar por URL de Moxfield/Archidekt (requiere un proxy en el servidor).
- Selección múltiple y arrastre en grupo, flechas de objetivo y fases del turno.
- Cuentas, mazos guardados y matchmaking por nivel de poder (bracket).
