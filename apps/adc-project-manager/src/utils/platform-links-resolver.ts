/**
 * Resolver de enlaces de plataforma para Project Management, expuesto como
 * remote de Module Federation (`./platformLinkResolver` en `config.json`).
 *
 * Resuelve el título legible de un enlace según su ruta:
 *   - `/:orgSlug/:projectSlug[/tab]` → nombre del proyecto/tablero.
 *   - `/issues/:id` o `?issue=:id`   → `key + título` de la tarea.
 * Mapea 401/403 a `denied` y 404 a `missing`. Lo consume cualquier app cargando
 * este remote bajo demanda (aunque Projects nunca se haya abierto).
 */
import type { PlatformLinkRef, PlatformLinkResolver } from "@ui-library/utils/platform-links";

import { pmApi } from "./pm-api.ts";

/** 401/403 → sin acceso; cualquier otro fallo → entidad inexistente. */
function statusFromHttp(httpStatus?: number): "denied" | "missing" {
	return httpStatus === 401 || httpStatus === 403 ? "denied" : "missing";
}

const resolvePlatformLink: PlatformLinkResolver = async (ref: PlatformLinkRef) => {
	// Tarea: /issues/:id o ?issue=:id
	const issueId = ref.query.get("issue") ?? (ref.segments[0] === "issues" ? ref.segments[1] : undefined);
	if (issueId) {
		const res = await pmApi.getIssue(issueId);
		if (!res.success || !res.data) return { status: statusFromHttp(res.status) };
		return { title: res.data.title, subtitle: res.data.key };
	}

	// Proyecto/tablero: /:orgSlug/:projectSlug[/tab]
	const [orgSlug, projectSlug] = ref.segments;
	if (orgSlug && projectSlug) {
		const res = await pmApi.getProjectBySlug(orgSlug, projectSlug);
		if (!res.success || !res.data) return { status: statusFromHttp(res.status) };
		return { title: res.data.name };
	}

	return null;
};

export default resolvePlatformLink;
