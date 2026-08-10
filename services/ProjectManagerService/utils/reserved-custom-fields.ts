import type { CustomFieldValue } from "@common/types/project-manager/CustomField.ts";

/**
 * Claves de `customFields` que escribe **sólo** la plataforma (creación de tickets/solicitudes,
 * cascada de baja y barrido de retención).
 *
 * `customFields` es un blob libre que el editor del tablero reenvía entero en cada guardado, así que
 * sin esta lista cualquiera con permiso de edición sobre un issue podría marcarlo como
 * `type: "support_ticket"` y meterlo en el barrido de retención —que anonimiza y después BORRA el
 * issue con sus comentarios y adjuntos—, pisar el vencimiento de un ticket real o desvincularlo de
 * la cuenta que lo abrió (rompiendo la cascada de baja, que matchea por esos ids).
 *
 * Deliberadamente NO incluye los campos de triage que el runbook pide completar desde el tablero
 * (`severity`, `duplicateOf`, `rewardGranted`, `publicDisclosure`, `wantsCredit`, `creditName`,
 * `sla*`, `authority*`): esos son del equipo, no de la máquina.
 */
const RESERVED_CUSTOM_FIELDS: ReadonlySet<string> = new Set([
	// Discriminadores: de ellos dependen el barrido de retención y el log público de bug bounty.
	"type",
	"ticketType",
	"bugBounty",
	"authority",
	// Marcas del barrido de retención.
	"retentionStage",
	"retentionAt",
	"purgeDueAt",
	// Copias del texto y datos de contacto de quien reportó (los borra la anonimización).
	"ticketTitle",
	"reporterEmail",
	"reportedByUserId",
	"reportedByEmail",
	"originalDescription",
	"descriptionHash",
	"creditRevocationHash",
	"creditOwnerUserId",
	// Solicitudes de alta de organización (misma colección, misma cascada de baja).
	"requestedByUserId",
	"requestedByEmail",
	"requestIp",
]);

/**
 * `customFields` de una escritura de usuario con las claves reservadas ignoradas: se conserva el
 * valor ya guardado (o ninguno, si es un alta). Se descartan en silencio en vez de rechazar la
 * request porque el diálogo del tablero reenvía el blob completo, incluidas esas claves.
 */
export function applyReservedCustomFields(
	incoming: Record<string, CustomFieldValue>,
	stored: Record<string, CustomFieldValue> = {}
): Record<string, CustomFieldValue> {
	const safe: Record<string, CustomFieldValue> = {};
	// Se respeta el orden de llegada (que es el del documento, porque el cliente reenvía lo que
	// leyó): así una edición que no cambió nada no genera una entrada de historial con el blob
	// entero, que el diff compara serializado.
	for (const [key, value] of Object.entries(incoming)) {
		if (!RESERVED_CUSTOM_FIELDS.has(key)) safe[key] = value;
		else if (key in stored) safe[key] = stored[key];
	}
	for (const key of RESERVED_CUSTOM_FIELDS) {
		if (key in stored && !(key in safe)) safe[key] = stored[key];
	}
	return safe;
}
