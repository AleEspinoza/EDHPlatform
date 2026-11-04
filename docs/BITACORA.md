# EDH Platform — estado y bitácora

Mesa virtual de Commander (EDH) inspirada en EDHPlay, con mejoras propias. Al 3 de noviembre de 2026 va en la **versión 0.10**: 18 commits y 35 pruebas automáticas que pasan.

- **Repo:** [github.com/AleEspinoza/EDHPlatform](https://github.com/AleEspinoza/EDHPlatform) (público, rama `main`)
- **Correr en local:** `npm install && npm start` → `http://localhost:3000` (requiere Node 22.13 o superior)
- **Pruebas:** `npm test` (motor de juego, API, cuentas, Google simulado y partida por sockets)
- **Prompts de arte:** documento «Prompts de arte para EDH Platform» (claude.ai/artifact/WBwuAz3gWk3jd8Egw2FENE)

## Objetivo

Tener una plataforma propia para jugar Commander en línea con amigos, con **todas las mecánicas de una partida que ofrece EDHPlay** y mejoras que EDHPlay no tiene.

- **Base, paridad con EDHPlay:** salas privadas, mazos importados y todas las acciones dentro de la sala (girar, enderezar, robar, mandar al cementerio, etc.), con los mismos atajos de teclado.
- **Mejoras propias:**
  - lanzar moneda y dados con un comando de chat;
  - botones con animación para avisar «Respondo», «Tengo un trigger», «Espera» y «OK»;
  - tapetes a elección, incluidos los animados.
- **Cuenta de jugador:** entrar con Google; en la cuenta, los mazos, las partidas pasadas y el historial.
- **Experiencia:** que se vea y se sienta como un juego de cartas digital, en la dirección de Hearthstone.
- **Compartir:** publicarla en una página para que otras personas la prueben.
- **Lo más ambicioso:** jugar contra una IA que juegue excelente.

## Qué hace hoy

| Área | Estado |
| --- | --- |
| Salas | Privadas con código de 6 letras y link de invitación, hasta 6 jugadores, reconexión al mismo asiento |
| Cuentas | Obligatorias para jugar; usuario y contraseña, o Google (implementado, falta activar credenciales) |
| Tu inicio | Mis mazos, historial de partidas y estadísticas (récord, % de victorias, turnos, duración, por comandante) |
| Mazos | Pegar lista (Moxfield, Archidekt, MTGO) con imágenes de Scryfall; guardar y jugar con un clic |
| Mecánicas | Todas las zonas, robar, moler, girar, contadores, tokens, adjuntar, cambio de control, enviar cartas a otros, zonas rivales, mulligan, buscar y mirar tope o fondo |
| Mesa | Fases, maná flotante, flechas a cualquier cosa, selección múltiple, +X/+Y, vida, veneno y daño de comandante |
| Mejoras sobre EDHPlay | Carteles de cómic animados (Trigger, Respondo, Espera, OK, Tu turno), comandos de chat (`/moneda`, `/dado 2d6`…), reacciones |
| Atajos | Idénticos a los de EDHPlay por defecto y reasignables (tecla `I`) |
| Solitario | Práctica con asientos extra que controlas tú |
| Estilo | Taberna tipo Hearthstone en la mesa; portada «Placa rúnica» con el logo; tapetes por jugador (imágenes, 6 animados, 15 colores), Olas por defecto |
| Persistencia | Lista para Turso (falta crear la base); en local, archivo |
| Publicación | Listo para Render gratis (`render.yaml`); aún sin desplegar |

## Decisiones clave

| Decisión | Por qué |
| --- | --- |
| No usar REA para copiar EDHPlay | REA es un MCP de ingeniería inversa. La mecánica de una mesa de Commander es estándar, así que se construyó desde cero con código propio, sin tocar el JS ni los assets de EDHPlay. |
| Servidor autoritativo (Node + Socket.IO) | La mano y la biblioteca ajenas nunca llegan al navegador rival: la información oculta se protege en el servidor. |
| Reglas manuales, como en papel | Las cartas son imágenes y los jugadores aplican las reglas. Un motor de reglas completo es un proyecto de años (ver IA en próximos pasos). |
| Base libSQL (Turso) | Mismo SQLite en local (archivo) y en producción (Turso, fuera del servidor), porque en Render gratis el disco se borra. |
| Claves solo en variables de entorno | El repo es público: `render.yaml` declara los nombres sin valores y en local van en `.env`, que no se sube. |
| Moxfield por link, apagado | Moxfield no tiene API pública ni login para terceros, y prohíbe el scraping sin permiso. El importador queda listo y se activa con `MOXFIELD_USER_AGENT` cuando ellos lo autoricen. |
| Dirección visual Hearthstone | Elegida por Alejandro. El arte lo genera él con los prompts del documento de arte. |
| Imágenes sin licencia clara fuera del repo | El repo es público. Los tapetes `mats/prueba-*` funcionan en local pero están en `.gitignore`. |
| Sin marcas de terceros | Se descartó la pila de cartas generada porque traía el logo de Hearthstone en el reverso. |

## Cronología

| Versión | Fecha | Qué se agregó |
| --- | --- | --- |
| 0.1 | 01/11 | Mesa básica: salas privadas, importar mazo, zonas y acciones, vida y daño de comandante, log y chat |
| 0.2 | 01/11 | Anuncios animados (Respondo, Trigger…) y comandos de chat; primer commit en GitHub |
| 0.3 | 01/11 | Adjuntar, cambio de control, tokens de Scryfall, ficha de carta, zonas rivales, modo solitario |
| 0.4 | 01/11 | Cuentas con usuario y contraseña, mazos guardados, importador de Moxfield (apagado) |
| 0.5 | 01/11 | Primer rediseño visual (descartado después: no convenció) |
| 0.6 | 01/11 | Login con Google, cuenta obligatoria, historial y estadísticas, terminar partida, atajos reasignables |
| 0.7 | 01/11 | Estilo Taberna con el arte de Alejandro, atajos idénticos a EDHPlay, flechas, fases, maná, reacciones |
| 0.8 | 01/11 | Campo en todo el tapete, mano sin parpadeo, flechas a cualquier zona, enviar cartas a otros, tapetes elegibles |
| 0.10 | 03/11 | Cuentas persistentes: base libSQL lista para Turso, `.env` local para las claves |
| 0.9 | 01/11 | Tapetes animados tipo lámpara de lava, tapetes de Alejandro (Olas por defecto), logo y portada «Placa rúnica», blueprint de Render |

## Dónde está cada cosa

| Ruta | Contenido |
| --- | --- |
| `server/game.js` | Motor: estado de la sala, acciones validadas, vista filtrada por jugador |
| `server/index.js` | Servidor HTTP + Socket.IO, salas, reconexión, manifiesto de arte |
| `server/api.js`, `auth.js`, `google.js` | Cuentas, sesiones, login con Google, mazos, importación |
| `server/db.js`, `history.js` | Conexión libSQL/Turso, esquema, historial y estadísticas |
| `public/` | Cliente sin compilación: `app.js` (interfaz), `deck.js` (listas y Scryfall), `style.css` |
| `public/assets/` | Arte: tapetes, marcos, carteles, logo (cada imagen es opcional, con respaldo CSS) |
| `test/` | Pruebas automáticas |
| `render.yaml` | Despliegue en Render |

## Detalles a recordar

- El commit `ea6f457` dice «Tapetes…» pero contiene la primera versión del logo y la portada. Ya está publicado, así que no se reescribió.
- En Chrome, `Ctrl+1/2/3` cambian de pestaña y no llegan a la página; conviene reasignar esos atajos.
- La paleta de colores original traía NAVY con el mismo código que ORANGE; se usó azul marino `#1260B0`.
