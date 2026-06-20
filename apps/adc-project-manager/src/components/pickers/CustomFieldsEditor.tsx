import { useTranslation } from "@ui-library/utils/i18n-react";
import type { CustomFieldDef, CustomFieldValue } from "@common/types/project-manager/CustomField.ts";
import { CustomFieldInput } from "./CustomFieldInput.tsx";

interface Props {
	defs: CustomFieldDef[];
	values: Record<string, CustomFieldValue>;
	onChange: (values: Record<string, CustomFieldValue>) => void;
	disabled?: boolean;
}

/**
 * Renderiza los inputs de custom fields según su `type` y mantiene sincronizado
 * el objeto `values` indexado por `def.id`.
 */
export function CustomFieldsEditor({ defs, values, onChange, disabled }: Readonly<Props>) {
	const { t } = useTranslation({ namespace: "adc-project-manager" });
	if (defs.length === 0) return null;

	const set = (id: string, value: CustomFieldValue) => onChange({ ...values, [id]: value });

	return (
		<div className="space-y-2">
			<h5 className="text-sm font-semibold text-text">{t("customFields.title")}</h5>
			<div className="grid grid-cols-2 gap-2">
				{defs.map((def) => (
					<CustomFieldInput
						key={def.id}
						def={def}
						value={values[def.id] ?? null}
						onSet={(value) => set(def.id, value)}
						disabled={disabled}
					/>
				))}
			</div>
		</div>
	);
}
