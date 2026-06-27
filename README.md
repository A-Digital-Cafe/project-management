# project-management [![Security](https://github.com/A-Digital-Cafe/project-management/actions/workflows/security.yml/badge.svg)](https://github.com/A-Digital-Cafe/project-management/actions/workflows/security.yml)

Preset de gestión de proyectos. Provee `ProjectManagerService` (proyectos, sprints, milestones, issues, comentarios y adjuntos, con persistencia en MongoDB) y la app `adc-project-manager`.

## Contenido

- `services/ProjectManagerService/` — Servicio con endpoints CRUD y DAOs de proyectos, sprints, milestones, issues, tickets de soporte y solicitudes de organización.
- `apps/adc-project-manager/` — App UI federada (host) que consume `ProjectManagerService`, `IdentityManagerService` y `SEOService`.

## Uso

Declarar la dependencia del servicio en el `config.json` de la app por nombre:

```json
{ "services": [{ "name": "ProjectManagerService", "version": "latest" }] }
```

El preset es opcional: si la carpeta está presente, el servicio y la app se cargan; si no, la plataforma funciona igual.
