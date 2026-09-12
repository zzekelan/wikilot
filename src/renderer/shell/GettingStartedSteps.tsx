/** The next setup action stays in the Timeline, with model setup before sending. */
export function GettingStartedSteps({
  activeStep,
  onActiveStep,
  needsModel,
  onConnectModel,
}: {
  activeStep: 1 | 2 | 3;
  onActiveStep: (step: 1 | 2 | 3) => void;
  needsModel: boolean;
  onConnectModel: () => void;
}) {
  const steps = [
    { label: "Open a Workspace", active: activeStep === 1, action: () => onActiveStep(1) },
    { label: "New Session", active: activeStep === 2, action: () => onActiveStep(2) },
    ...(needsModel ? [{ label: "Connect a model", active: activeStep === 3, action: onConnectModel }] : []),
    { label: "Send a message", active: activeStep === 3 && !needsModel, action: () => onActiveStep(3) },
  ];
  return <ol className="shell-empty-steps">
    {steps.map((step, index) => <li key={step.label}>
      {step.active ? <button type="button" className="shell-empty-step shell-empty-step-active shell-empty-step-btn" onClick={step.action}>
        <span className="shell-empty-step-no" aria-hidden="true">{index + 1}</span>
        <span className="shell-empty-step-label">{step.label}</span>
      </button> : <span className="shell-empty-step">
        <span className="shell-empty-step-no" aria-hidden="true">{index + 1}</span>
        {step.label}
      </span>}
    </li>)}
  </ol>;
}
