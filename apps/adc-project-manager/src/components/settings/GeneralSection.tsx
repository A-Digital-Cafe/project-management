import { useEffect, useState } from "react";
import { useTranslation } from "@ui-library/utils/i18n-react";
import type { Project } from "@common/types/project-manager/Project.ts";
import { pmApi } from "../../utils/pm-api.ts";

interface Props {
	project: Project;
	canEdit: boolean;
	onSaved: () => void | Promise<void>;
}

export function GeneralSection({ project, canEdit, onSaved }: Readonly<Props>) {
	const { t } = useTranslation({ namespace: "adc-project-manager" });
	const [name, setName] = useState(project.name);
	const [description, setDescription] = useState(project.description ?? "");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Sólo al cambiar de proyecto: con [project] el refetch de cada guardado pisaría lo que el usuario está tipeando.
	useEffect(() => {
		setName(project.name);
		setDescription(project.description ?? "");
	}, [project.id]);

	const save = async () => {
		setSaving(true);
		setError(null);
		const res = await pmApi.updateProject(project.id, { name, description });
		setSaving(false);
		if (!res.success) {
			setError(res.errorKey ?? "error");
			return;
		}
		await onSaved();
	};

	return (
		<div className="space-y-3 max-w-xl">
			<div>
				<label className="block text-sm font-medium text-text mb-1">{t("settings.name")}</label>
				<adc-input value={name} onInput={(e: any) => setName(e.target.value)} disabled={!canEdit} />
			</div>
			<div>
				<label className="block text-sm font-medium text-text mb-1">{t("settings.description")}</label>
				<adc-textarea value={description} onInput={(e: any) => setDescription(e.target.value)} disabled={!canEdit} rows={3} />
			</div>
			{/* Sólo lectura: el orgId se deriva de la visibilidad al crear, así que el backend la ignora en el PUT genérico. */}
			<div>
				<label className="block text-sm font-medium text-text mb-1">{t("settings.visibility")}</label>
				<p className="text-sm text-text">{t(`settings.visibility_${project.visibility}`)}</p>
				<p className="text-xs text-muted mt-1">{t("settings.visibilityLocked")}</p>
			</div>
			{error && <p className="text-sm text-tdanger">{error}</p>}
			{canEdit && (
				<adc-button variant="primary" onClick={save} disabled={saving}>
					{t("common.save")}
				</adc-button>
			)}
		</div>
	);
}
