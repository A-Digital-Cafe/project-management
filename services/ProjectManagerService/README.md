# ProjectManagerService

Gestión de proyectos tipo Jira: proyectos, sprints, milestones, issues, labels, custom fields.

- Multi-tenant (`orgId`) con proyectos globales (`orgId: null`)
- Permisos por recurso `project-manager` (bitfield scopes)
- Visibilidad (`utils/project-access.ts`): owner/miembro, org del token o público; ningún rol global ve tableros ajenos (sólo los de sistema, `ownerId: "system"`)
- Integrado con `IdentityManagerService` para usuarios y grupos
- Update log append-only, issue keys autogenerados (`PROJ-123`)
- Kanban con columnas configurables y WIP limits (modo foco)
- Solicitudes de organización vía issue en proyecto configurado
- Baja/export de cuenta: `purgeUserPrivateData` y `exportUserData` (tickets de soporte propios), handshake `identity:internal`
- Retención de tickets: trabajo ocioso `support-ticket-retention` (anonimiza → purga según `SUPPORT_TICKET_RETENTION`; nunca un TTL sobre `issues`)
- Canal de autoridades (`POST /api/pm/support-tickets/authority`): sin sesión, fail-closed contra `AuditLogService` (503 si no hay registro)
- Crédito de bug bounty revocable sin cuenta (`POST /api/pm/bug-bounty/credit-revocation`, código entregado al reportar)
