import { useTranslation } from "@ui-library/utils/i18n-react";
import type { BadgeOption, CustomFieldDef, CustomFieldType } from "@common/types/project-manager/CustomField.ts";
import { BadgeOptionRow } from "./BadgeOptionRow.tsx";

const FIELD_TYPES: CustomFieldType[] = ["text", "number", "date", "label", "badge", "user"];

interface Props {
	def: CustomFieldDef;
	canEdit: boolean;
	onUpdate: (patch: Partial<CustomFieldDef>) => void;
	onRemove: () => void;
	onUpdateBadge: (index: number, patch: Partial<BadgeOption>) => void;
	onAddBadge: () => void;
	onRemoveBadge: (index: number) => void;
}

/** Fila editable de una definición de custom field (nombre, tipo, opciones). */
export function CustomFieldRow({ def, canEdit, onUpdate, onRemove, onUpdateBadge, onAddBadge, onRemoveBadge }: Readonly<Props>) {
	const { t } = useTranslation({ namespace: "adc-project-manager" });
	return (
		<li className="p-2 border border-border rounded-md bg-surface space-y-2">
			<div className="flex items-center gap-2">
				<adc-input value={def.name} onInput={(e: any) => onUpdate({ name: e.target.value })} disabled={!canEdit} />
				<adc-combobox
					value={def.type}
					clearable={false}
					options={JSON.stringify(FIELD_TYPES.map((x) => ({ label: t(`customFields.type_${x}`), value: x })))}
					onadcChange={(e: any) => onUpdate({ type: e.detail as CustomFieldType })}
					disabled={!canEdit}
				/>
				<label className="flex items-center gap-1 text-xs whitespace-nowrap">
					<input type="checkbox" checked={!!def.required} onChange={(e) => onUpdate({ required: e.target.checked })} disabled={!canEdit} />
					{t("settings.required")}
				</label>
				<button
					type="button"
					onClick={onRemove}
					disabled={!canEdit}
					className="ml-auto text-tdanger font-bold text-sm disabled:opacity-30"
					aria-label={t("common.delete")}
				>
					×
				</button>
			</div>
			{def.type === "label" && (
				<div>
					<label className="block text-xs mb-1 text-muted">{t("settings.options")}</label>
					<adc-input
						value={(def.options ?? []).join(", ")}
						placeholder="option1, option2, option3"
						onInput={(e: any) =>
							onUpdate({
								options: e.target.value
									.split(",")
									.map((s: string) => s.trim())
									.filter(Boolean),
							})
						}
						disabled={!canEdit}
					/>
				</div>
			)}
			{def.type === "badge" && (
				<div className="space-y-2">
					<label className="block text-xs text-muted">{t("settings.badgeOptions")}</label>
					<ul className="space-y-1.5">
						{(def.badgeOptions ?? []).map((opt, idx) => (
							<BadgeOptionRow
								key={"opt" + idx}
								option={opt}
								disabled={!canEdit}
								onName={(name) => onUpdateBadge(idx, { name })}
								onColor={(color) => onUpdateBadge(idx, { color })}
								onRemove={() => onRemoveBadge(idx)}
							/>
						))}
					</ul>
					{canEdit && (
						<adc-button variant="accent" onClick={onAddBadge}>
							{t("settings.addBadgeOption")}
						</adc-button>
					)}
				</div>
			)}
		</li>
	);
}
