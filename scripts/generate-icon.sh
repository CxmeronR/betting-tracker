#!/bin/bash
# Generate app icon from SVG
# Requires: sips (built into macOS) and iconutil (built into macOS)

set -e

ICON_DIR="build/icon.iconset"
mkdir -p "$ICON_DIR"

# Create a simple SVG icon
cat > build/icon.svg << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0a0a1a"/>
      <stop offset="100%" style="stop-color:#1a1a2e"/>
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#00e68a"/>
      <stop offset="100%" style="stop-color:#00b368"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="220" fill="url(#bg)"/>
  <rect x="180" y="180" width="664" height="664" rx="80" fill="none" stroke="url(#accent)" stroke-width="40"/>
  <!-- Chart bars -->
  <rect x="280" y="520" width="80" height="220" rx="16" fill="#00e68a" opacity="0.4"/>
  <rect x="400" y="380" width="80" height="360" rx="16" fill="#00e68a" opacity="0.6"/>
  <rect x="520" y="300" width="80" height="440" rx="16" fill="#00e68a" opacity="0.8"/>
  <rect x="640" y="220" width="80" height="520" rx="16" fill="#00e68a"/>
  <!-- Trend line -->
  <path d="M320 580 L440 450 L560 380 L680 280" fill="none" stroke="white" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
  <!-- Dollar sign -->
  <text x="512" y="175" font-family="SF Pro Display, Helvetica" font-size="100" font-weight="700" fill="#00e68a" text-anchor="middle" opacity="0.6">$</text>
</svg>
EOF

echo "SVG icon created at build/icon.svg"
echo ""
echo "To generate .icns (macOS only):"
echo "  1. Open build/icon.svg in Preview or a browser"
echo "  2. Export as 1024x1024 PNG → build/icon.png"
echo "  3. Run:"
echo "     sips -z 16 16     build/icon.png --out build/icon.iconset/icon_16x16.png"
echo "     sips -z 32 32     build/icon.png --out build/icon.iconset/icon_16x16@2x.png"
echo "     sips -z 32 32     build/icon.png --out build/icon.iconset/icon_32x32.png"
echo "     sips -z 64 64     build/icon.png --out build/icon.iconset/icon_32x32@2x.png"
echo "     sips -z 128 128   build/icon.png --out build/icon.iconset/icon_128x128.png"
echo "     sips -z 256 256   build/icon.png --out build/icon.iconset/icon_128x128@2x.png"
echo "     sips -z 256 256   build/icon.png --out build/icon.iconset/icon_256x256.png"
echo "     sips -z 512 512   build/icon.png --out build/icon.iconset/icon_256x256@2x.png"
echo "     sips -z 512 512   build/icon.png --out build/icon.iconset/icon_512x512.png"
echo "     sips -z 1024 1024 build/icon.png --out build/icon.iconset/icon_512x512@2x.png"
echo "     iconutil -c icns build/icon.iconset -o build/icon.icns"
echo ""
echo "Or just install the npm package 'png-to-ico' or use an online converter."
