# AGENTS.md - udesa-x-notifications-api

<!-- INICIO BLOQUE PROPIO - completado en cada servicio -->

Notificaciones de UdeSA-X: consume los eventos de RabbitMQ que publican `users-api` y
`posts-api`, manda emails y push por FCM, y guarda el historial en MongoDB para el centro de
notificaciones in-app. Épica `E4` (Notificaciones). El stack sale del ADR-015 de
`udesa-x-platform`.

## Stack y herramientas

- Lenguaje y runtime: TypeScript / Bun / Hono, igual que `udesa-x-api-gateway`
- Gestor de paquetes: Bun
- Persistencia: MongoDB con el driver oficial, sin ORM y sin migraciones de esquema
- Cola: RabbitMQ con `amqplib`

## Checks y comandos

```bash
bun install
bun run test:unit       # tests unitarios, sin dependencias
bun run test            # unitarios e integración: necesita MongoDB y RabbitMQ levantados
bun run lint            # ESLint + Prettier
bun run build           # tsc --noEmit
docker compose -f docker/docker-compose.dev.yml --profile test run --rm tests   # la suite como en el CI
```

## Arquitectura y particularidades locales

- Capas del ADR-007: `src/api/` (rutas y errores HTTP), `src/app/` (lógica del servicio, sin
  saber de HTTP ni de la base) y `src/infrastructure/` (MongoDB, RabbitMQ, salud, telemetría).
- `src/index.ts` es el único módulo que conoce las implementaciones concretas: abre las
  conexiones y se las pasa a `createApp`. Los tests arman la app con dobles por la misma puerta.
- `MONGODB_URL` y `RABBITMQ_URL` son obligatorias: sin alguna, el proceso no arranca.
- Si RabbitMQ se cae, el servicio sigue vivo y se reconecta solo con backoff. Mientras tanto
  `/healthcheck` responde `503` y `/livez` sigue en `200`, para que Kubernetes lo saque del
  tráfico sin reiniciarlo.
- Los tests de `tests/integration/` corren contra MongoDB y RabbitMQ reales. En el CI los
  levanta `ci-node.yml` con `mongodb-y-rabbitmq: true`.
- Documentación general del sistema: consultar `../udesa-x-platform/docs/` (`ARQUITECTURA.md`,
  `CONVENCIONES.md`, `PLANIFICACION.md`).

<!-- FIN BLOQUE PROPIO -->

<!-- INICIO BLOQUE COMUN - sincronizado desde udesa-x-platform, no editar la copia local -->

## Reglas del equipo

- **Ramas e issues**: Rama base `main`. Ramas de trabajo `feature-<nombre>` (funcionalidad), `fix-<nombre>` (defecto) o `chore-<nombre>` (mantenimiento y tooling, etiqueta `tech debt`), siempre asociadas a un issue en el mismo repositorio.
- **Idiomas**:
  - Código (`src/`, `tests/`), nombres de archivos, identificadores y comentarios en código: **inglés**.
  - Documentación (`docs/`, `README.md`), mensajes de commit y Pull Requests: **español**.
- **Commits**: Formato Conventional Commits (`feat:`, `fix:`, `docs:`, etc.) con descripción en español.
- **Simplicidad**: Soluciones mínimas y directas para el criterio de aceptación. No introducir librerías, patrones ni abstracciones nuevas sin un ADR aprobado en `docs/adr/`.

## Límites y flujo de trabajo del agente

- El agente inspecciona el repositorio (`git status`, `git diff`), edita archivos en el working tree, ejecuta checks locales y redacta propuestas de commit y PR.
- **El agente nunca commitea, pushea ni abre/aprueba/mergea Pull Requests.** La revisión y confirmación en Git la realiza siempre un integrante del equipo.
- **Sin firmas**: Nunca agregar `Co-Authored-By`, firmas o menciones del agente en commits, PRs ni código.

## Modo de planificación

- Planes extremadamente concisos: priorizar brevedad y concreción por sobre prosa formal.
- Al final de cada plan, incluir la lista de preguntas o dudas pendientes a resolver (si las hay).

## Skills (.agents/skills/)

- `explicar-implementacion`: Genera la explicación detallada del cambio para incluir en la descripción del PR.
- `revisar-pr`: Guía paso a paso para la revisión técnica de Pull Requests.

<!-- FIN BLOQUE COMUN -->
