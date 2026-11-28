import { Formik, type FormikConfig, type FormikProps, type FormikValues } from "formik";
import { type ReactNode, useEffect } from "react";
import Modal from "react-bootstrap/Modal";
import { intl } from "src/locale";

// The host dialogs (proxy, redirection, 404, stream): wide enough for the forward host picker and its
// suggestions, the custom location cards and the advanced config. Phones still get the full width.
const HOST_MODAL_SIZE = "lg";

const confirmDiscardChanges = (dirty: boolean) =>
	!dirty ||
	window.confirm(
		intl.formatMessage({
			id: "form.unsaved-changes",
			defaultMessage: "You have unsaved changes. Are you sure you want to discard them?",
		}),
	);

const FormDirtyState = ({ dirty, onChange }: { dirty: boolean; onChange: (dirty: boolean) => void }) => {
	useEffect(() => {
		onChange(dirty);
		return () => onChange(false);
	}, [dirty, onChange]);

	return null;
};

interface FormModalProps<Values extends FormikValues> extends Omit<FormikConfig<Values>, "children"> {
	show: boolean;
	onHide: () => void;
	preventHide?: boolean;
	// Bootstrap modal width ("lg": 800px from the lg breakpoint, full width on phones as always)
	size?: "sm" | "lg" | "xl";
	children: (props: FormikProps<Values> & { onHide: () => void }) => ReactNode;
}

const FormModal = <Values extends FormikValues>({
	show,
	onHide,
	preventHide = false,
	size,
	children,
	...formikProps
}: FormModalProps<Values>) => (
	<Formik {...formikProps}>
		{(formikProps) => {
			const handleHide = () => {
				if (!preventHide && confirmDiscardChanges(formikProps.dirty)) {
					onHide();
				}
			};

			return (
				<Modal show={show} onHide={handleHide} size={size}>
					{children({ ...formikProps, onHide: handleHide })}
				</Modal>
			);
		}}
	</Formik>
);

export { confirmDiscardChanges, FormDirtyState, FormModal, HOST_MODAL_SIZE };
