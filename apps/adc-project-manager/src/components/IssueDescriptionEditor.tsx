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
					className="w-full text-left mb-2 px-3 py-2 rounded-md border border-twarn/30 bg-warn text-twarn text-sm hover:bg-warn/80 cursor-pointer"
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
					className={`w-full text-left rounded-md border border-text/15 bg-surface p-3 min-h-12 select-text ${canEdit ? "cursor-text hover:border-primary/60" : "cursor-default"}`}
					onDoubleClick={canEdit ? desc.startEditing : undefined}
					title={canEdit ? (t("issues.descriptionDoubleClickToEdit") ?? "Doble clic para editar") : undefined}
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
