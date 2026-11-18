import React, { useId, useState } from 'react';

interface PitStopLogoProps {
  variant?: 'full' | 'horizontal' | 'icon';
  animated?: boolean;
  className?: string;
}

export const PitStopLogo: React.FC<PitStopLogoProps> = ({
  variant = 'horizontal',
  animated = false,
  className = '',
}) => {
  const uid = useId().replace(/:/g, '');
  const silverId = `ps-silver-${uid}`;
  const redId = `ps-red-${uid}`;
  const frameId = `ps-frame-${uid}`;
  const [imgError, setImgError] = useState(false);

  if (variant === 'icon') {
    return (
      <svg
        viewBox="0 0 64 64"
        className={`select-none ${className}`}
        role="img"
        aria-label="PitStop Sports"
      >
        <defs>
          <linearGradient id={silverId} x1="0" y1="0" x2="0.85" y2="1">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="52%" stopColor="#C0C4C9" />
            <stop offset="100%" stopColor="#6D7278" />
          </linearGradient>
          <linearGradient id={redId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FF3B30" />
            <stop offset="52%" stopColor="#E10600" />
            <stop offset="100%" stopColor="#8F0400" />
          </linearGradient>
        </defs>
        <rect
          x="2"
          y="2"
          width="60"
          height="60"
          rx="13"
          fill="#080B0D"
          stroke="#2E323A"
          strokeWidth="2"
        />
        <path
          d="M14 50 L25 13 L45 13 C52 13 55 18 53 26 C51 34 44 38 35 38 L26 38 L22 50 Z"
          fill={`url(#${silverId})`}
        />
        <path
          d="M27 21 L39 21 C43 21 44 23 43 27 C42 30 39 32 34 32 L24 32 Z"
          fill="#080B0D"
        />
        <path
          d="M39 13 L51 13 C56 17 57 25 51 33 L42 36 C48 31 49 23 44 17 Z"
          fill={`url(#${redId})`}
        />
        <path d="M9 47 L22 41 L19 52 Z" fill={`url(#${redId})`} />
      </svg>
    );
  }

  if (variant === 'horizontal') {
    return (
      <svg
        viewBox="0 0 280 74"
        className={`select-none ${className}`}
        role="img"
        aria-label="PitStop Sports"
      >
        <defs>
          <linearGradient id={silverId} x1="0" y1="0" x2="0.2" y2="1">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="50%" stopColor="#C0C4C9" />
            <stop offset="100%" stopColor="#777C82" />
          </linearGradient>
          <linearGradient id={redId} x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0%" stopColor="#FF332D" />
            <stop offset="50%" stopColor="#E10600" />
            <stop offset="100%" stopColor="#8F0300" />
          </linearGradient>
        </defs>
        <path d="M8 14 L250 5 L270 11 L248 16 L18 18 Z" fill={`url(#${silverId})`} opacity="0.92" />
        <path d="M236 16 L265 11 L246 42 L231 42 L247 17 Z" fill={`url(#${redId})`} />
        <text
          x="16"
          y="46"
          fontFamily="'Barlow Condensed', sans-serif"
          fontWeight="800"
          fontStyle="italic"
          fontSize="40"
          letterSpacing="1"
          fill={`url(#${silverId})`}
        >
          PIT
        </text>
        <text
          x="74"
          y="46"
          fontFamily="'Barlow Condensed', sans-serif"
          fontWeight="800"
          fontStyle="italic"
          fontSize="40"
          letterSpacing="1"
          fill={`url(#${redId})`}
        >
          STOP
        </text>
        <path d="M18 60 L64 60 L61 63 L15 63 Z" fill="#E10600" />
        <path d="M190 60 L236 60 L233 63 L187 63 Z" fill="#E10600" />
        <text
          x="126"
          y="65"
          textAnchor="middle"
          fontFamily="'Barlow Condensed', sans-serif"
          fontWeight="700"
          fontStyle="italic"
          fontSize="16"
          letterSpacing="6.5"
          fill="#C0C4C9"
        >
          SPORTS
        </text>
      </svg>
    );
  }

  // Full Início Hero: 3333.png seamlessly edge-dissolved into #080B0D with synchronized diagonal metallic & crimson light sweeps (no square box, no extra bar)
  return (
    <div className={`relative flex w-full items-center justify-center ${className}`}>
      {!imgError ? (
        <div
          className="relative w-full max-w-[680px] overflow-hidden"
          style={{
            WebkitMaskImage:
              'radial-gradient(ellipse 76% 72% at 50% 50%, rgba(0,0,0,1) 42%, rgba(0,0,0,0.72) 66%, rgba(0,0,0,0) 97%)',
            maskImage:
              'radial-gradient(ellipse 76% 72% at 50% 50%, rgba(0,0,0,1) 42%, rgba(0,0,0,0.72) 66%, rgba(0,0,0,0) 97%)',
          }}
        >
          <img
            src="/pitstop-hero-3333.webp"
            alt="PitStop Sports"
            referrerPolicy="no-referrer"
            onError={() => setImgError(true)}
            className="block h-auto w-full select-none object-cover"
          />

          {/* Synchronized animated diagonal lighting running along the actual 3333.png speed blades */}
          {animated && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden mix-blend-screen"
            >
              <div className="pitstop-hero-glow-red absolute inset-0" />
              <div className="pitstop-diag-sheen absolute -inset-x-1/2 top-1/3 h-16 w-[200%] bg-gradient-to-r from-transparent via-white/25 to-transparent blur-md" />
              <div className="pitstop-diag-sheen-delayed absolute -inset-x-1/2 bottom-1/4 h-12 w-[200%] bg-gradient-to-r from-transparent via-[#FF2A2A]/35 to-transparent blur-lg" />
            </div>
          )}
        </div>
      ) : (
        <svg
          viewBox="0 0 460 150"
          className="relative z-10 w-full max-w-[380px] sm:max-w-[430px] select-none drop-shadow-[0_14px_30px_rgba(225,6,0,0.22)]"
          role="img"
          aria-label="PitStop Sports"
        >
          <defs>
            <linearGradient id={silverId} x1="0" y1="0" x2="0.25" y2="1">
              <stop offset="0%" stopColor="#FFFFFF" />
              <stop offset="48%" stopColor="#C0C4C9" />
              <stop offset="100%" stopColor="#6B7077" />
            </linearGradient>
            <linearGradient id={redId} x1="0" y1="0" x2="0.4" y2="1">
              <stop offset="0%" stopColor="#FF3B30" />
              <stop offset="50%" stopColor="#E10600" />
              <stop offset="100%" stopColor="#850300" />
            </linearGradient>
            <linearGradient id={frameId} x1="0" y1="0" x2="1" y2="0.2">
              <stop offset="0%" stopColor="#C0C4C9" />
              <stop offset="65%" stopColor="#FFFFFF" />
              <stop offset="100%" stopColor="#8A8F96" />
            </linearGradient>
          </defs>
          <path
            d="M18 33 L418 14 L444 14 L394 94 L350 96 L386 35 L32 38 Z"
            fill={`url(#${frameId})`}
            opacity="0.94"
          />
          <path d="M396 22 L434 19 L400 78 L374 79 Z" fill={`url(#${redId})`} />
          <path d="M124 22 L286 15 L278 21 L118 26 Z" fill="#E10600" opacity="0.9" />
          <text
            x="32"
            y="92"
            fontFamily="'Barlow Condensed', sans-serif"
            fontWeight="800"
            fontStyle="italic"
            fontSize="78"
            letterSpacing="1.5"
            fill={`url(#${silverId})`}
            stroke="#080B0D"
            strokeWidth="2.5"
            paintOrder="stroke"
          >
            PIT
          </text>
          <text
            x="146"
            y="92"
            fontFamily="'Barlow Condensed', sans-serif"
            fontWeight="800"
            fontStyle="italic"
            fontSize="78"
            letterSpacing="1.5"
            fill={`url(#${redId})`}
            stroke="#080B0D"
            strokeWidth="2.5"
            paintOrder="stroke"
          >
            STOP
          </text>
          <path d="M58 103 L376 92 L364 99 L48 108 Z" fill={`url(#${silverId})`} opacity="0.88" />
          <path d="M56 125 L122 125 L117 130 L51 130 Z" fill="#E10600" />
          <path d="M318 125 L384 125 L379 130 L313 130 Z" fill="#E10600" />
          <text
            x="220"
            y="134"
            textAnchor="middle"
            fontFamily="'Barlow Condensed', sans-serif"
            fontWeight="700"
            fontStyle="italic"
            fontSize="26"
            letterSpacing="11"
            fill="#E5E7EB"
          >
            SPORTS
          </text>
        </svg>
      )}
    </div>
  );
};
