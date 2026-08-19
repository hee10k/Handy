import React from "react";

/* eslint-disable i18next/no-literal-string -- brand wordmark: "타자기" is a proper noun constant, not a translation. */

const HandyTextLogo = ({
  width,
  height,
  className,
}: {
  width?: number;
  height?: number;
  className?: string;
}) => {
  return (
    <svg
      width={width}
      height={height}
      className={className}
      viewBox="0 0 930 328"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="타자기"
    >
      <text
        x="465"
        y="164"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="ui-sans-serif, -apple-system, 'Segoe UI', Roboto, 'Noto Sans KR', sans-serif"
        fontWeight="700"
        fontSize="150"
        fill="currentColor"
      >
        타자기
      </text>
    </svg>
  );
};

export default HandyTextLogo;