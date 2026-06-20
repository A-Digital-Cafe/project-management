import type { Permission } from "@common/types/identity/Permission.ts";
import { canAccessProjects } from "./permissions.ts";
import { pmApi } from "./pm-api.ts";

const VALID_TABS = new Set(["board", "backlog", "calendar", "sprints", "milestones", "settings"]);

interface ParsedRoute {
	orgSlug?: string;
	projectSlug?: string;
	tab?: string;
}

/**
 * Routing:
 *   /                                      → Project list
 *   /:orgSlug/:projectSlug                 → Project detail (default: board tab)
 *   /:orgSlug/:projectSlug/:tab            → Board | Sprints | Milestones | …
 *   orgSlug === "default" ⇒ proyecto global
 */
export function parseRoute(path: string): ParsedRoute {
	const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
	if (parts.length >= 2) {
		const tab = parts[2] && VALID_TABS.has(parts[2]) ? parts[2] : "board";
		return { orgSlug: parts[0], projectSlug: parts[1], tab };
	}
	return {};
}

/**
 * Determina si un usuario autenticado puede entrar al app: por permiso formal
 * PM.READ, por ser miembro de algún proyecto, o por poder crear uno privado
 * (cualquier usuario autenticado).
 */
export async function resolveProjectAccess(perms: Permission[], userId: string): Promise<boolean> {
	if (canAccessProjects(perms)) return true;
	const listRes = await pmApi.listProjects();
	if (listRes.success && listRes.data?.projects?.length) return true;
	return !!userId;
}
