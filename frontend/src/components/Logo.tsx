export default function Logo() {
  return (
    <>
      <style>{`
        .mark-c { gap: 0; display: inline-flex; }
        .mark-c .word { position: relative; padding-bottom: 4px; }
        .mark-c .word::after {
          content: "";
          position: absolute;
          left: 0; right: 0; bottom: 0;
          height: 6px;
          border-bottom: 1.5px solid #2F5D3A;
          border-radius: 50%;
        }
      `}</style>
      <div className="mark-c">
        <span
          className="word"
          style={{ fontFamily: "'Fraunces', serif", fontSize: '2rem', color: '#2F6B4F', fontWeight: 600, textTransform: 'lowercase' }}
        >
          canopy
        </span>
      </div>
    </>
  );
}
