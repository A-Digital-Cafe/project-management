import { type Project, SYSTEM_PROJECT_OWNER_ID } from "@common/types/project-manager/Project.ts";
import type { User } from "@common/types/identity/User.ts";

/** Owner de los tableros que crea y opera el propio servicio (tickets, solicitudes de org). */
export const SYSTEM_OWNER_ID = SYSTEM_PROJECT_OWNER_ID;

/**
 * Contexto mínimo del caller para decidir el acceso a un tablero. `PMCtx` lo
 * satisface; se declara acá para que el predicado no dependa de los DAOs.
 */
export interface ProjectAccessCtx {
	userId: string;
	groupIds: string[];
	tokenOrgId: string | null;
	/** Permiso formal `project-manager:PROJECTS:READ` a nivel global (token sin orgId). */
	hasGlobalPMRead: boolean;
	/** Rol `Admin` global (token sin orgId). */
	isGlobalAdmin: boolean;
}

/**
 * Un proyecto org-scoped (`orgId != null`) sólo es accesible si el token actual
 * del caller apunta a esa misma organización. Un token personal (`tokenOrgId=null`)
 * no debe ver/operar proyectos de org aunque el usuario sea miembro.
 *
 * Para proyectos globales (`orgId=null`) no aplica restricción de org.
 */
export function isProjectAccessibleInOrgContext(project: Project | null | undefined, tokenOrgId: string | null | undefined): boolean {
	if (!project) return false;
	if (!project.orgId) return true;
	return (tokenOrgId ?? null) === project.orgId;
}

/** Owner, miembro directo o miembro por grupo. No mira el contexto de org. */
function isExplicitMember(project: Project, userId: string, groupIds: readonly string[]): boolean {
	if (!userId) return false;
	if (project.ownerId === userId) return true;
	if (project.memberUserIds?.includes(userId)) return true;
	return project.memberGroupIds?.some((gid) => groupIds.includes(gid)) ?? false;
}

/**
 * Determina si un usuario tiene acceso a un proyecto según membresía directa,
 * membresía por grupo o role override.
 *
 * No reemplaza el chequeo de permisos del recurso `project-manager`; lo complementa.
 *
 * Si el proyecto es org-scoped, `tokenOrgId` debe coincidir con `project.orgId`;
 * de lo contrario se deniega sin importar la membresía (aislamiento de contexto).
 */
export function isProjectMember(
	project: Project | null | undefined,
	user: Pick<User, "id" | "groupIds"> | null,
	tokenOrgId: string | null = null
): boolean {
	if (!project || !user) return false;
	if (!isProjectAccessibleInOrgContext(project, tokenOrgId)) return false;
	return isExplicitMember(project, user.id, user.groupIds ?? []);
}

/** `true` si el tablero lo gestiona el servicio (tickets de soporte, solicitudes de org). */
export function isSystemBoard(project: Project | null | undefined): boolean {
	return project?.ownerId === SYSTEM_OWNER_ID;
}

/**
 * ¿Puede el caller ver este tablero? **Única fuente de verdad** de la visibilidad
 * de un proyecto: la usan tanto el listado como el gate de acceso por id/slug.
 *
 * El permiso formal de `project-manager` NO alcanza para llegar al tablero de otro:
 * un rol global (Admin, Project Manager) puede administrar la plataforma, pero los
 * tableros privados y los de una organización ajena son datos de sus dueños. El rol
 * global sólo agrega los **tableros de sistema**, que son de la plataforma y no de
 * un usuario (ahí viven los tickets de soporte y las solicitudes de alta de org).
 */
export function isProjectVisible(project: Project | null | undefined, ctx: ProjectAccessCtx): boolean {
	if (!project) return false;

	// Aislamiento por contexto: un tablero de org sólo se ve con el token en esa org.
	// Como `switch-org` valida la pertenencia, esto ya implica "soy miembro de la org".
	if (!isProjectAccessibleInOrgContext(project, ctx.tokenOrgId)) return false;

	// Membresía explícita (owner, miembro directo o por grupo).
	if (isExplicitMember(project, ctx.userId, ctx.groupIds)) return true;

	// Tableros de sistema: gestión de plataforma, no datos de un usuario.
	if (isSystemBoard(project)) return ctx.isGlobalAdmin || ctx.hasGlobalPMRead;

	// Privado ajeno: nadie más, ni con permiso formal.
	if (project.visibility === "private") return false;

	// Global no privado = público: cualquier sesión válida.
	if (project.orgId === null) return true;

	// Tablero de org: el token ya quedó validado contra `project.orgId` arriba.
	return true;
}

/** Filtra una lista de proyectos con el mismo criterio que `isProjectVisible`. */
export function filterVisibleProjects(projects: Project[], ctx: ProjectAccessCtx): Project[] {
	return projects.filter((p) => isProjectVisible(p, ctx));
}
