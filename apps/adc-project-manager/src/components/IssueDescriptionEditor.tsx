import { useTranslation } from "@ui-library/utils/i18n-react";
import type { IssueDescriptionController } from "../hooks/useIssueDescription.ts";

interface Props {
	desc: IssueDescriptionController;
	canEdit: boolean;
}

/** Columna de descripción del issue: banner de draft, editor de bloques y render. */
export function IssueDescriptionEditor({ desc, canEdit }: Readonly<Props>) {
	const { t } = useTranslation({ namespace: "adc-project-manager" });
	return (
		<div className="min-w-0">
			<label className="block text-sm font-medium mb-1 text-text">{t("common.description")}</label>
			{desc.hasUnsavedDraft && !desc.editing && (
				<button
					type="button"
					className="w-full text-left mb-2 px-3 py-2 rounded-md border border-warning bg-warning/10 text-warning text-sm hover:bg-warning/15 cursor-pointer"
					onClick={desc.resumeDraft}
				>
					{t("issues.descriptionUnsavedChanges") ?? "Tienes cambios sin guardar — clic para retomar"}
				</button>
			)}
			{desc.editing ? (
				<adc-blocks-form
					placeholder={t("issues.descriptionPlaceholder") ?? "Describe el issue con bloques..."}
					initialBlocks={desc.description}
					initialAttachmentIds={desc.attachmentIds}
					attachmentUrls={desc.attachmentUrls}
					disabled={!canEdit}
					submitLabel={t("common.save") ?? "Guardar"}
					showCancel
					onadcCancel={desc.cancel}
					onadcSubmit={(ev: any) => desc.submit(ev.detail)}
					onadcDraftChange={(ev: any) => desc.draftChange(ev.detail)}
					onadcRequestAttachment={(ev: CustomEvent<{ kind: "image" | "file" }>) => desc.requestAttachment(ev.detail.kind)}
				/>
			) : (
				<button
					type="button"
					className={`w-full text-left rounded-md border border-text/15 bg-surface p-3 min-h-12 ${canEdit ? "cursor-text hover:border-primary/60" : "cursor-default"}`}
					onClick={desc.startEditing}
					title={canEdit ? (t("issues.descriptionClickToEdit") ?? "Clic para editar") : undefined}
				>
					{desc.savedDescription.length === 0 ? (
						<span className="text-muted text-sm italic">{t("issues.descriptionEmpty") ?? "Sin descripción"}</span>
					) : (
						<adc-blocks-renderer blocks={desc.savedDescription} attachmentUrls={desc.attachmentUrls} />
					)}
				</button>
			)}
		</div>
	);
}
