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
  "version": "0.1.0",
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

## Configuración

| Variable                      | Default                  | Para qué                                        |
| ----------------------------- | ------------------------ | ----------------------------------------------- |
| `MONGODB_URL`                 | sin definir, obligatoria | URL de MongoDB, con la base en el path          |
| `RABBITMQ_URL`                | sin definir, obligatoria | URL AMQP de RabbitMQ                            |
| `PORT`                        | `8000`                   | Puerto donde escucha el servicio                |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | sin definir              | Si está, manda trazas y logs por OTLP (ADR-013) |

Sin `MONGODB_URL` o `RABBITMQ_URL` el proceso no arranca y dice cuál falta.

## Eventos que consume

Ninguno todavía. El primero, `user.registered` para el email de verificación, llega con
[#5](https://github.com/tds-g3-2s2026/udesa-x-notifications-api/issues/5).

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

La suite completa, dentro de la imagen y como la corre el CI:

```bash
docker compose -f docker/docker-compose.dev.yml --profile test run --rm tests
```

En el CI, `ci-node.yml` de `udesa-x-platform` levanta MongoDB y RabbitMQ al lado del job
(`mongodb-y-rabbitmq: true`), corre la suite en la imagen de tests y verifica que la imagen de
producción responda `200` en `/healthcheck`.
