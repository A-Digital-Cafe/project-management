import { useState } from "react";
import { useTranslation } from "@ui-library/utils/i18n-react";
import type { Project } from "@common/types/project-manager/Project.ts";
import type { CustomFieldDef } from "@common/types/project-manager/CustomField.ts";
import { shortId } from "@common/utils/client-crypto.ts";
import { pmApi } from "../../utils/pm-api.ts";
import { CustomFieldRow } from "./CustomFieldRow.tsx";
import { addBadgeOption, findInvalidDef, removeBadgeOption, removeField, updateBadgeOption, updateField } from "./customFieldDefs.ts";

interface Props {
	project: Project;
	canEdit: boolean;
	onSaved: () => void | Promise<void>;
}

export function CustomFieldsSection({ project, canEdit, onSaved }: Readonly<Props>) {
	const { t } = useTranslation({ namespace: "adc-project-manager" });
	const [defs, setDefs] = useState<CustomFieldDef[]>(project.customFieldDefs);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const add = () => setDefs((prev) => [...prev, { id: shortId(), name: t("settings.newField"), type: "text" }]);

	const save = async () => {
		const invalid = findInvalidDef(defs);
		if (invalid) {
			setError(t(invalid.errorKey, { name: invalid.name }));
			return;
		}
		setSaving(true);
		setError(null);
		const res = await pmApi.updateCustomFields(project.id, defs);
		setSaving(false);
		if (!res.success) {
			setError(res.errorKey ?? "error");
			return;
		}
		await onSaved();
	};

	return (
		<div className="space-y-3">
			<ul className="space-y-2">
				{defs.map((d) => (
					<CustomFieldRow
						key={d.id}
						def={d}
						canEdit={canEdit}
						onUpdate={(patch) => setDefs((prev) => updateField(prev, d.id, patch))}
						onRemove={() => setDefs((prev) => removeField(prev, d.id))}
						onUpdateBadge={(index, patch) => setDefs((prev) => updateBadgeOption(prev, d.id, index, patch))}
						onAddBadge={() => setDefs((prev) => addBadgeOption(prev, d.id, { name: t("settings.newBadgeOption"), color: "blue" }))}
						onRemoveBadge={(index) => setDefs((prev) => removeBadgeOption(prev, d.id, index))}
					/>
				))}
			</ul>
			{canEdit && (
				<div className="flex gap-2">
					<adc-button variant="accent" onClick={add}>
						{t("settings.addField")}
					</adc-button>
					<adc-button variant="primary" onClick={save} disabled={saving}>
						{saving ? t("common.saving") : t("common.save")}
					</adc-button>
				</div>
			)}
			{error && <p className="text-sm text-tdanger">{error}</p>}
		</div>
	);
}
