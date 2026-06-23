const IT = "'Inter Tight', sans-serif";

interface AppStepperProps {
  step: number;
  total?: number;
}

export default function AppStepper({ step, total = 3 }: AppStepperProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', paddingTop: '0.6rem' }}>
      <span style={{ fontFamily: IT, fontSize: '0.7rem', letterSpacing: '0.16em', color: '#A8A8A0', fontWeight: 500, textTransform: 'uppercase' }}>
        STEP {String(step).padStart(2, '0')} / {String(total).padStart(2, '0')}
      </span>
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
        {Array.from({ length: total }, (_, i) => (
          <div
            key={i}
            style={{
              width: '28px',
              height: '2px',
              borderRadius: '1px',
              backgroundColor: i < step ? '#2F5D3A' : '#D4CFC7',
            }}
          />
        ))}
      </div>
    </div>
  );
}
