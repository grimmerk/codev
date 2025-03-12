import React, { useState } from 'react';
import './button.css';

interface Props {
  height?: number;
  width?: number;
  children?: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
}

// Enhanced hover button with improved animations and styling
export const HoverButton: React.FC<Props> = (props) => {
  const { children, onClick, style, ...dimensions } = props;
  const [isHovered, setIsHovered] = useState(false);
  
  // Default color theme
  const theme = {
    text: '#fff',
    bg: 'rgba(165, 29, 42, 0.7)',
    bgHover: 'rgba(193, 34, 48, 0.9)'
  };
  
  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{ display: 'flex', alignItems: 'center' }}
    >
      <button 
        className={isHovered ? 'displayed' : 'notdisplayed'}
        style={{
          ...dimensions,
          ...style,
          backgroundColor: isHovered ? theme.bgHover : theme.bg,
          color: theme.text,
          opacity: isHovered ? 1 : 0,
          transition: 'opacity 0.2s ease, background-color 0.2s ease',
          width: dimensions.width || 28,
          height: dimensions.height || 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '14px',
          fontWeight: 'bold'
        }}
        onClick={onClick}
      >
        {children}
      </button>
    </div>
  );
};
