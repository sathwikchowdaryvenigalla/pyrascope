const SATS = [['MODIS', 'MODIS'], ['VIIRS', 'VIIRS'], ['BOTH', 'Both']];
export default function SatToggle({ value, onChange, options = SATS, label = 'Satellite' }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button type="button" key={v} aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}
