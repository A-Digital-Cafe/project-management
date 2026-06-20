import type { BadgeOption, CustomFieldDef } from "@common/types/project-manager/CustomField.ts";

/** Transformaciones puras sobre la lista de definiciones de custom fields. */

export function updateField(defs: CustomFieldDef[], id: string, patch: Partial<CustomFieldDef>): CustomFieldDef[] {
	return defs.map((d) => (d.id === id ? { ...d, ...patch } : d));
}

export function removeField(defs: CustomFieldDef[], id: string): CustomFieldDef[] {
	return defs.filter((d) => d.id !== id);
}

export function updateBadgeOption(defs: CustomFieldDef[], fieldId: string, index: number, patch: Partial<BadgeOption>): CustomFieldDef[] {
	return defs.map((d) => {
		if (d.id !== fieldId) return d;
		const next = [...(d.badgeOptions ?? [])];
		next[index] = { ...next[index], ...patch };
		return { ...d, badgeOptions: next };
	});
}

export function addBadgeOption(defs: CustomFieldDef[], fieldId: string, option: BadgeOption): CustomFieldDef[] {
	return defs.map((d) => (d.id === fieldId ? { ...d, badgeOptions: [...(d.badgeOptions ?? []), option] } : d));
}

export function removeBadgeOption(defs: CustomFieldDef[], fieldId: string, index: number): CustomFieldDef[] {
	return defs.map((d) => (d.id === fieldId ? { ...d, badgeOptions: (d.badgeOptions ?? []).filter((_, i) => i !== index) } : d));
}

/**
 * Valida que `label`/`badge` tengan opciones. Devuelve la clave de error + el
 * nombre del campo inválido, o `null` si todo es válido.
 */
export function findInvalidDef(defs: CustomFieldDef[]): { errorKey: string; name: string } | null {
	for (const d of defs) {
		if (d.type === "label" && (!d.options || d.options.length === 0)) return { errorKey: "settings.errors.labelNeedsOptions", name: d.name };
		if (d.type === "badge" && (!d.badgeOptions || d.badgeOptions.length === 0)) return { errorKey: "settings.errors.badgeNeedsOptions", name: d.name };
	}
	return null;
}
