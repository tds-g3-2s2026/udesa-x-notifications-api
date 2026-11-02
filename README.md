# udesa-x-notifications-api

Microservicio de notificaciones: cola, push, emails y triage de IA. Consume los eventos que
publican `users-api` y `posts-api` por RabbitMQ, manda emails y push por FCM, y guarda el
historial en MongoDB para el centro de notificaciones in-app (`E4-H3`).

**Stack:** TypeScript sobre Bun, [Hono](https://hono.dev/) para HTTP, MongoDB con el driver
oficial (sin ORM), RabbitMQ con `amqplib`. Tests con Vitest, lint con ESLint y Prettier. Es el
mismo stack que `udesa-x-api-gateway`; la decisión está en el
[ADR-015](https://github.com/tds-g3-2s2026/udesa-x-platform/blob/main/docs/adr/ADR-015-notifications-api-en-bun-y-hono.md).

## Levantarlo en desarrollo

```bash
docker compose -f docker/docker-compose.dev.yml up --build
```

Levanta el servicio, MongoDB 8 y RabbitMQ 4 con su interfaz de administración. Todos los puertos
quedan en `127.0.0.1`:

| Qué                      | Dónde                                                     |
| ------------------------ | --------------------------------------------------------- |
| `notifications-api`      | `http://localhost:8003`                                   |
| MongoDB                  | `mongodb://localhost:27017`                               |
| RabbitMQ                 | `amqp://notifications:notifications@localhost:5672`       |
| Administración de Rabbit | `http://localhost:15672`, usuario y clave `notifications` |

El servicio usa `8003` porque `8000`, `8001` y `8002` ya son de `users-api`, `posts-api` y el
gateway.

```bash
curl http://localhost:8003/healthcheck
```

## Salud

| Ruta           | Para qué                 | Responde                                                              |
| -------------- | ------------------------ | --------------------------------------------------------------------- |
| `/healthcheck` | `readinessProbe` y el CI | `200` con `status: "ok"` si MongoDB y RabbitMQ responden, `503` si no |
| `/livez`       | `livenessProbe`          | `200` siempre que el proceso esté vivo, sin mirar dependencias        |

El cuerpo de `/healthcheck` tiene la misma forma que en `users-api` y `posts-api`:

```json
{
  "status": "degraded",
  "version": "1.2.0",
  "dependencies": { "mongodb": "ok", "rabbitmq": "connect ECONNREFUSED 10.0.0.12:5672" }
}
```

**Si se cae RabbitMQ o MongoDB, el servicio no se reinicia.** `/healthcheck` pasa a `503`,
Kubernetes lo saca del tráfico y `/livez` sigue en `200`. Contra RabbitMQ se reconecta solo,
con la recuperación de `amqplib`: primer reintento al segundo, duplicando hasta 30 segundos,
sin límite de intentos. El driver de MongoDB se reconecta por su cuenta. Los cortes y las
reconexiones quedan en el log.

## Errores

Toda respuesta de error usa Problem Details (RFC 9457) con `application/problem+json`, con el
formato de `ARQUITECTURA.md` en `udesa-x-platform`. Un error no previsto responde un `500`
genérico: el detalle real va solo al log, con el mismo `traceId` que recibe el cliente.

## API

Lo que llama la app, a través del gateway: todo `/api/notifications` se rutea a este servicio.
Cada ruta pide `Authorization: Bearer <access token>` de `users-api`. El servicio verifica la
firma con `JWT_PUBLIC_KEY`, el vencimiento y que el emisor sea `JWT_ISSUER`, sin llamar a nadie.
No revisa si la sesión fue cerrada: un token revocado sirve hasta que vence, como máximo 15
minutos, y en ese rato puede leer, marcar y borrar las notificaciones de la cuenta. `posts-api`
sí lo revisa (ADR-014); acá se acepta esa ventana a propósito. Un token inválido responde `401`
con `code: invalid-token`, igual que `users-api` y `posts-api`. La cuenta sale siempre del `sub`
del token: ninguna ruta deja nombrar otra.

### Registro del dispositivo

`POST /api/notifications/device-tokens` con `{ "token": "<token de FCM>" }` responde `204` sin
cuerpo. La app lo llama después de cada login exitoso, también si el token no cambió (`E4-H1`
CA.3): así el token queda a nombre de la cuenta que inició sesión última en ese dispositivo, y
uno que se había borrado vuelve a estar vivo. Repetirlo no cambia nada más que la fecha.

Un cuerpo que no es JSON, sin `token`, con uno que no es texto, vacío o de más de 4096
caracteres responde `422` con `code: validation-failed` y
`errors: [{ "field": "token", ... }]`, como el formato de validación de `ARQUITECTURA.md`.

### Centro de notificaciones

| Ruta                                | Responde                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/notifications?cursor=...` | `200` con una página: 20 como máximo, de la más reciente a la más antigua |
| `POST /api/notifications/read-all`  | `204` sin cuerpo: marca leídas todas las no leídas de la cuenta           |
| `DELETE /api/notifications/{id}`    | `204` sin cuerpo: borrado lógico, la notificación deja de listarse        |

La página tiene la forma de todo listado paginado del sistema (`ARQUITECTURA.md`, "Paginación
por cursor"), en camelCase:

```json
{
  "items": [
    {
      "id": "0199f3a5-2c3d-7f4e-9051-6b7c8d9e0f12",
      "type": "reply",
      "actor": { "id": "0f8c2a5e-4b7d-4e1a-9c3f-2d6b8a1e5f70", "handle": "juanperez" },
      "postId": "0199e8b1-5d6e-7f80-9a1b-2c3d4e5f6a7b",
      "replyId": "0199f3a5-2c3d-7f4e-9051-6b7c8d9e0f99",
      "createdAt": "2026-10-23T14:09:02.000Z",
      "readAt": null
    }
  ],
  "nextCursor": "MjAyNi0xMC0yM1QxNDowOTowMi4wMDBafDAxOTlmM2E1..."
}
```

- `type`: `follow`, `like`, `retweet` o `reply`. Pueden sumarse otros (las menciones, por
  ejemplo), así que la app tiene que tolerar uno que no conoce.
- `actor.handle`: tal cual llega en el evento, **sin `@`** (`juanperez`). Puede ser `null` si
  `posts-api` no lo conocía. El texto ("@juanperez te empezó a seguir") lo arma la app.
- `postId`: el post que recibió la interacción, el que se abre al tocarla. `null` en un
  `follow`.
- `replyId`: solo en `reply`, el post de la respuesta; `null` en los demás.
- `createdAt`: cuándo pasó, el `time` del evento.
- `readAt`: `null` mientras no se leyó. Es el indicador de no leída.

`nextCursor` es `null` en la última página; si no, la app lo devuelve tal cual en `?cursor=`.
Un cursor que el servicio no emitió responde `400` con `code: invalid-cursor`. El tamaño de
página es fijo.

`read-all` no toca las que ya estaban leídas (conservan su `readAt`) ni las borradas. Marca
también las que llegaron después de que la app cargó la lista. `DELETE` responde `204` también
si la notificación ya estaba borrada, así un reintento no falla. Para una notificación de otra
cuenta, un id que no existe o uno mal formado responde lo mismo: `404` con
`code: notification-not-found`, sin decir si el id existe.

Nada se borra de la base. Cada notificación es un documento de la colección `notifications`:

| Campo          | Contenido                                                        |
| -------------- | ---------------------------------------------------------------- |
| `_id`          | `id` del evento que la generó: el mismo evento no crea dos       |
| `recipient_id` | cuenta que la ve                                                 |
| `type`         | `follow`, `like`, `retweet` o `reply`                            |
| `actor_id`     | cuenta que hizo la acción                                        |
| `actor_handle` | handle de esa cuenta según el evento, o `null`                   |
| `post_id`      | post de la interacción; `null` en un `follow`                    |
| `reply_id`     | post de la respuesta en un `reply`; `null` en los demás          |
| `created_at`   | `time` del evento                                                |
| `read_at`      | cuándo se leyó; `null` mientras no                               |
| `deleted_at`   | cuándo se borró; `null` mientras no. Una borrada no se lista más |

El listado se sostiene con el índice `{ recipient_id: 1, deleted_at: 1, created_at: -1, _id: -1 }`,
que el servicio crea al arrancar. Si MongoDB no responde en ese momento, lo deja en el log y
sigue: el listado anda igual, más lento, hasta que un reinicio lo cree.

Las notificaciones las van a crear los consumidores de `follow.created` e `interaction.created`.
Mientras no estén, para probar el centro de punta a punta se cargan a mano. Con el compose
levantado, y `<cuenta>` igual al `sub` del token con el que se llama (ver el comentario de
`JWT_PUBLIC_KEY` en `docker/docker-compose.dev.yml`):

```bash
docker compose -f docker/docker-compose.dev.yml exec mongodb mongosh notifications --quiet --eval '
const account = "<cuenta>";
const now = Date.now();
db.notifications.insertMany(Array.from({ length: 25 }, (_, i) => ({
  _id: crypto.randomUUID(),
  recipient_id: account,
  type: ["follow", "like", "retweet", "reply"][i % 4],
  actor_id: crypto.randomUUID(),
  actor_handle: i % 5 === 0 ? null : "juanperez",
  post_id: i % 4 === 0 ? null : crypto.randomUUID(),
  reply_id: i % 4 === 3 ? crypto.randomUUID() : null,
  created_at: new Date(now - i * 60000),
  read_at: null,
  deleted_at: null,
})));'
```

Son 25, así que la primera página trae 20 y un `nextCursor`, y la segunda las 5 restantes.

## Configuración

| Variable                      | Default                         | Para qué                                                                |
| ----------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `MONGODB_URL`                 | sin definir, obligatoria        | URL de MongoDB, con la base en el path                                  |
| `RABBITMQ_URL`                | sin definir, obligatoria        | URL AMQP de RabbitMQ                                                    |
| `JWT_PUBLIC_KEY`              | sin definir, obligatoria        | Clave pública Ed25519 en PEM, la otra mitad de la que firma `users-api` |
| `JWT_ISSUER`                  | `users-api`                     | Emisor que tienen que traer los access tokens                           |
| `PORT`                        | `8000`                          | Puerto donde escucha el servicio                                        |
| `EMAIL_PROVIDER`              | `console`                       | `console` imprime el mail en el log; `resend` lo manda (ADR-010)        |
| `RESEND_API_KEY`              | sin definir                     | Clave de Resend. Obligatoria con `EMAIL_PROVIDER=resend`                |
| `EMAIL_FROM`                  | `UdeSA-X <no-reply@udesax.app>` | Remitente; el dominio `udesax.app` está verificado en Resend            |
| `PUSH_PROVIDER`               | `console`                       | `console` imprime el push en el log; `fcm` lo manda por FCM             |
| `FIREBASE_SERVICE_ACCOUNT`    | sin definir                     | JSON entero del service account de Firebase. Obligatoria con `fcm`      |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | sin definir                     | Si está, manda trazas y logs por OTLP (ADR-013)                         |

Sin `MONGODB_URL`, `RABBITMQ_URL` o `JWT_PUBLIC_KEY` el proceso no arranca y dice cuál falta. Con
`EMAIL_PROVIDER=resend` y sin `RESEND_API_KEY` tampoco arranca: sin clave, cada mail fallaría
recién con el primer evento. Un `EMAIL_PROVIDER` desconocido también lo frena. Lo mismo con
`PUSH_PROVIDER=fcm`: sin `FIREBASE_SERVICE_ACCOUNT`, o con uno que no es JSON, al que le falta
`project_id`, `client_email` o `private_key`, o cuya `private_key` no se puede leer, no arranca.
El error nunca muestra el contenido, porque trae la clave privada.

## Eventos que consume

Los emails de cuenta (verificación, recuperación y aviso de cambio de contraseña) viajan por
RabbitMQ: `users-api` publica el evento con el patrón outbox y este servicio manda el mail. Los
esquemas de cada evento están en `contracts/events/` (ADR-017); el sobre es CloudEvents 1.0 y
su `id` es la clave de idempotencia.

| Evento (`type`)                   | Email                                                 | Campos de `data` que usa               |
| --------------------------------- | ----------------------------------------------------- | -------------------------------------- |
| `user.registered.v1`              | Verificación: "Validá tu cuenta de UdeSA-X"           | `user_id`, `email`, `verification_url` |
| `email_verification.requested.v1` | Verificación (reenvío del link)                       | `user_id`, `email`, `verification_url` |
| `password.reset_requested.v1`     | Recuperación: "Recuperá tu contraseña de UdeSA-X"     | `user_id`, `email`, `token`            |
| `password.changed.v1`             | Aviso: "La contraseña de tu cuenta de UdeSA-X cambió" | `user_id`, `email`                     |

`verification_url` y `token` son secretos: no se loguean, no se guardan y no viajan en un error.
Solo el adaptador de consola de desarrollo los imprime, porque ese es su trabajo.

También consume `user.deleted.v1` (campo `user_id`), que no manda mail: borra lógicamente lo que
el servicio guarda de esa cuenta. Está más abajo, en "Cuenta eliminada".

### Topología en RabbitMQ

El servicio declara esto al arrancar y otra vez en cada reconexión (la recuperación de `amqplib`
corre el `setup` después de cada conexión exitosa, y también vuelve a registrar el consumidor):

| Qué                      | Nombre                  | Detalle                                                                     |
| ------------------------ | ----------------------- | --------------------------------------------------------------------------- |
| Exchange de eventos      | `udesa-x.events`        | `topic`, durable. Lo declara también `users-api`, con los mismos argumentos |
| Cola del servicio        | `notifications-api`     | `quorum`, durable, `x-dead-letter-exchange: udesa-x.events.dlx`             |
| Bindings de la cola      | las 5 routing keys      | Las 4 de los emails y `user.deleted.v1`                                     |
| Exchange de rechazados   | `udesa-x.events.dlx`    | `fanout`, durable                                                           |
| Cola de rechazados (DLQ) | `notifications-api.dlq` | `quorum`, durable, ligada al DLX                                            |

La routing key es el `type` completo. El consumidor es dueño de su cola: si `users-api` publica
antes de que exista, el broker devuelve el mensaje (publica con `mandatory`) y la fila de su
outbox queda pendiente, así que no se pierde nada. Consume con ack manual y `prefetch` 10. Se
puede ver en la interfaz de administración (`http://localhost:15672`).

Si el canal se cierra sin que se haya perdido la conexión (por ejemplo, el broker cancela el
consumidor), el servicio cierra la conexión para que la recuperación vuelva a declarar y a
consumir. En SIGTERM deja de tomar mensajes, termina los que tiene en curso y recién ahí cierra.

### Idempotencia y colección `emails`

RabbitMQ entrega al menos una vez, así que el mismo evento puede llegar repetido. Por cada
evento hay un documento en la colección `emails` de MongoDB, con `_id` igual al `id` del evento:

| Campo        | Contenido                                              |
| ------------ | ------------------------------------------------------ |
| `_id`        | `id` del evento                                        |
| `type`       | `type` del evento                                      |
| `user_id`    | usuario al que va el mail                              |
| `to`         | dirección de destino                                   |
| `status`     | `pending` (por enviarse o en curso), `sent` o `failed` |
| `created_at` | cuándo se recibió el evento                            |
| `sent_at`    | cuándo se envió; `null` mientras no esté `sent`        |

No se guarda el link, el código ni el cuerpo. MongoDB corre sin replica set, así que no hay
transacciones entre documentos: la atomicidad es la de un documento, el `insertOne` con `_id`
único.

1. Llega el evento: `insertOne` con `status: pending`.
2. Si el `_id` ya existía y está `sent` o `failed`, se descarta y se confirma (`ack`).
3. Si ya existía y sigue `pending`, un intento anterior se cayó a mitad de camino: se envía de
   nuevo. El peor caso es un mail repetido, y se acepta a propósito antes que perder uno.
4. Se envía, se pasa el documento a `sent` (o `failed`) y recién ahí se hace `ack`.

Dentro de un mismo proceso, dos mensajes con el mismo `id` que llegan a la vez se atienden uno
después del otro; con varias réplicas esa ventana sigue abierta y cuesta, como mucho, un mail
repetido.

Qué pasa con lo que no sale bien:

| Situación                                             | Qué hace el servicio                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| JSON inválido, `type` desconocido o `data` sin campos | Warning en el log sin el contenido y `nack` sin reencolar: va a la DLQ                                                                 |
| Resend rechaza el mail o no contesta en 5 s           | Se loguea asunto, destinatario y motivo (sin cuerpo), el mail queda `failed` y se hace `ack`. Los reintentos con backoff son la `T-59` |
| MongoDB u otra dependencia falla                      | `nack` con reencolado: el mensaje vuelve a la cola                                                                                     |

### Cuenta eliminada

Cuando `users-api` publica `user.deleted.v1`, el servicio marca con `deleted_at` (el `time` del
evento) los device tokens de la cuenta (`device_tokens`) y las notificaciones que recibió
(`notifications`). No borra ningún documento. Un token borrado no recibe más push, y vuelve a
estar vivo si alguien inicia sesión en ese dispositivo: el registro le pone `deleted_at: null`.

La idempotencia es por `id` del evento, con un documento por evento procesado en
`processed_events` (`_id`, `type`, `user_id`, `processed_at`). Como no hay transacciones entre
documentos, el orden importa:

1. Si el `id` ya está en `processed_events`, se descarta y se confirma (`ack`).
2. Se marcan los tokens y después las notificaciones. Cada `updateMany` filtra por
   `deleted_at: null`, así que repetirlo no cambia nada y conserva la fecha del primer borrado.
3. Recién entonces se guarda el evento en `processed_events` y se hace `ack`.

Si MongoDB falla a mitad de camino, el mensaje vuelve a la cola y el reintento termina lo que
faltaba. Un mensaje sin `id`, `time` o `data.user_id` va a la DLQ. Si dos entregas del mismo
evento se atienden a la vez, las dos pueden pasar el paso 1 y correr los `updateMany`. No hace
daño: escriben la misma fecha (la del evento) y queda un solo documento en `processed_events`.

No toca las notificaciones donde la cuenta borrada es la que hizo la acción: siguen
apareciéndole a quien las recibió, con su handle.

### Mandar un evento a mano

Con el compose levantado, desde la interfaz de administración (`Exchanges > udesa-x.events > Publish message`) se publica con la routing key igual al `type` y el sobre
como payload; los ejemplos están en `contracts/events/`. Con `EMAIL_PROVIDER=console` el mail
sale en el log del servicio, y repetir el mismo `id` no genera un segundo mail.

## Tests

```bash
bun install
bun run test:unit    # sin dependencias
bun run test         # unitarios e integración, con MongoDB y RabbitMQ del compose levantados
bun run lint
bun run build
```

`bun run test` toma `MONGODB_URL` y `RABBITMQ_URL` del entorno; con el compose levantado:

```bash
MONGODB_URL=mongodb://localhost:27017/notifications-test \
RABBITMQ_URL=amqp://notifications:notifications@localhost:5672 \
bun run test
```

Los tests del consumidor arman sus mensajes con los `examples` de `contracts/events/` y los
validan contra el esquema con `ajv` y `ajv-formats` (ADR-017). La integración publica en el
exchange real y comprueba el flujo completo: el mismo evento dos veces manda un solo mail y deja
un documento `sent`, la cola es `quorum` con sus bindings, un `user.deleted.v1` publicado borra
las notificaciones de la cuenta y los mensajes inválidos llegan a la DLQ. Usa la cola
`notifications-api`, así que no corre bien contra un broker donde ya esté consumiendo una
instancia del servicio.

El centro de notificaciones se prueba entero contra MongoDB real (`tests/integration/notifications-*`):
la app con el store de verdad, el orden y el cursor entre páginas, el desempate por id y que
MongoDB use el índice para la consulta de una página. Los tests unitarios cubren la parte HTTP
con dobles.

La suite completa, dentro de la imagen y como la corre el CI:

```bash
docker compose -f docker/docker-compose.dev.yml --profile test run --rm tests
```

En el CI, `ci-node.yml` de `udesa-x-platform` levanta MongoDB y RabbitMQ al lado del job
(`mongodb-y-rabbitmq: true`), corre la suite en la imagen de tests y verifica que la imagen de
producción responda `200` en `/healthcheck`.
