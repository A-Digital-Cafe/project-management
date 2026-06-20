import { useTranslation } from "@ui-library/utils/i18n-react";
import type { CustomFieldDef, CustomFieldValue } from "@common/types/project-manager/CustomField.ts";
import { UserPicker } from "./UserPicker.tsx";

interface Props {
	def: CustomFieldDef;
	value: CustomFieldValue;
	onSet: (value: CustomFieldValue) => void;
	disabled?: boolean;
}

function toDateInput(v: CustomFieldValue): string {
	if (!v || Array.isArray(v)) return "";
	const d = v instanceof Date ? v : new Date(v);
	if (Number.isNaN(d.getTime())) return "";
	return d.toISOString().slice(0, 10);
}

function toStringArray(v: CustomFieldValue): string[] {
	if (Array.isArray(v)) return v;
	return [];
}

/** Renderiza el input de un único custom field según su `type`. */
export function CustomFieldInput({ def, value, onSet, disabled }: Readonly<Props>) {
	const { t } = useTranslation({ namespace: "adc-project-manager" });
	return (
		<div>
			<label className="block text-xs font-medium mb-1 text-text">
				{def.name}
				{def.required && <span className="text-tdanger ml-0.5">*</span>}
			</label>
			{def.type === "text" && <adc-input value={(value as string) ?? ""} onInput={(e: any) => onSet(e.target.value)} disabled={disabled} />}
			{def.type === "number" && (
				<adc-input
					type="number"
					value={value !== null && !Array.isArray(value) ? String(value) : ""}
					onInput={(e: any) => onSet(e.target.value === "" ? null : Number(e.target.value))}
					disabled={disabled}
				/>
			)}
			{def.type === "date" && (
				<input
					type="date"
					className="w-full border border-border rounded-md px-2 py-1 text-sm bg-surface text-text"
					value={toDateInput(value)}
					onChange={(e) => onSet(e.target.value ? new Date(e.target.value) : null)}
					disabled={disabled}
				/>
			)}
			{def.type === "label" && (
				<adc-combobox
					value={(value as string) ?? ""}
					clearable
					options={JSON.stringify((def.options ?? []).map((o) => ({ label: o, value: o })))}
					onadcChange={(e: any) => onSet(e.detail || null)}
					disabled={disabled}
				/>
			)}
			{def.type === "badge" && (
				<div className="flex flex-wrap gap-1.5">
					{(def.badgeOptions ?? []).length === 0 && <span className="text-xs text-muted">{t("settings.noBadgeOptions")}</span>}
					{(def.badgeOptions ?? []).map((opt) => {
						const selected = toStringArray(value);
						const active = selected.includes(opt.name);
						const toggle = () => {
							const next = active ? selected.filter((s) => s !== opt.name) : [...selected, opt.name];
							onSet(next.length ? next : null);
						};
						return (
							<button
								key={opt.name}
								type="button"
								disabled={disabled}
								onClick={toggle}
								className={`rounded-full ${active ? "ring-2 ring-primary" : "opacity-70 hover:opacity-100"}`}
							>
								<adc-color-label color={opt.color} size="xs" dot={active}>
									{opt.name}
								</adc-color-label>
							</button>
						);
					})}
				</div>
			)}
			{def.type === "user" && (
				<UserPicker
					selectedIds={value && !Array.isArray(value) ? [value as string] : []}
					onChange={(ids) => onSet(ids[0] ?? null)}
					disabled={disabled}
				/>
			)}
		</div>
	);
}
