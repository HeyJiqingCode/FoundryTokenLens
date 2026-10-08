import brandMark from '../assets/brand-mark.svg';

export function BrandMark() {
  return (
    <img
      className="brand-mark"
      src={brandMark}
      width={42}
      height={42}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
