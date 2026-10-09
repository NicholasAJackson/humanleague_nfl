import React from 'react';
import { FANTASYCALC_HOME } from '../lib/fantasyCalc.js';
import './FantasyCalcAttribution.css';

export default function FantasyCalcAttribution({ extra }) {
  return (
    <p className="fc-attr">
      Trade values from{' '}
      <a href={FANTASYCALC_HOME} target="_blank" rel="noopener noreferrer">
        FantasyCalc
      </a>
      . Rankings generated from real fantasy football trades.
      {extra ? <> {extra}</> : null}
    </p>
  );
}
