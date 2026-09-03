# Ratchet Playbook v3

> Evolved context. Immutable — curation writes v4, never edits.
> Parent: v2 · 2026-09-03T06:36:40.925Z
> Curation: filmed evolution: ETH replay under v2

## SETUPS

[set-00001] helpful=30 harmful=5 (trend, range) :: dip-buy: 24h drop between {dipPct}% and {maxDipPct}% with RSI under {rsiMax} buys pullbacks, not knives knobs: dipPct=4, maxDipPct=6, rsiPeriod=14, rsiMax=35 :: evidence: 
[set-00002] helpful=10 harmful=1 (range) :: In range regime, tighten the dip window — current 3-12% dip range is too wide, allowing entries on shallow pullbacks that lack momentum. :: evidence: t000,t002,t003,t004,t006,t012

## FILTERS

[flt-00001] helpful=0 harmful=0 (volatile) :: skip dip-buys when the 24h range exceeds {volHiPct}% — wide ranges mean the dip has no floor yet knobs: volHiPct=6 :: evidence: 
[flt-00002] helpful=0 harmful=0 (unknown) :: no regime read, no trade — unknown is a verdict, not a gap to fill :: evidence: 
[flt-00003] helpful=0 harmful=0 (volatile) :: Skip dip-buys in volatile regime — the setup fails to find a floor, leading to frequent stops even when RSI conditions are met. :: evidence: t005,t007,t013,t014
[flt-00004] helpful=0 harmful=0 (unknown) :: deep-dip entries (adverse excursion >1.5R) lost $17.21 across 4 trades — tighten maxDipPct to 6 :: evidence: t003,t005,t007,t014

## EXITS

[exe-00001] helpful=0 harmful=0 (trend, range, volatile) :: exit mechanically: take {takePct}% or stop {stopPct}% or {maxHoldBars} bars, whichever prints first — lingering converts edge into noise knobs: takePct=2.5, stopPct=1.5, maxHoldBars=48 :: evidence: 

## SIZING

[siz-00001] helpful=0 harmful=0 (trend, range, volatile) :: risk 1% of equity per invalidation distance, capped at 25% notional — size from the stop, never from conviction :: evidence: 

## MISTAKES

[mis-00001] helpful=0 harmful=0 (trend, range, volatile) :: never reinforce a lucky win — a profit without thesis confirmation is a tax on future discipline :: evidence: 
[mis-00002] helpful=0 harmful=0 (unknown) :: 2 win(s) printed without thesis confirmation — exits left edge on the table; take profit mechanically at target instead of lingering :: evidence: t007,t014,t005
[mis-00003] helpful=0 harmful=0 (volatile) :: Enforce mechanical exit discipline — lucky wins (t007, t014) scored -1 and eroded edge; lingering converts edge into noise as per exe-00001. :: evidence: t007,t014

## WATCH

~~[wat-00001] helpful=0 harmful=0 (unknown) :: do post-loss entries size up? watch: entries within 6 bars of a loss vs baseline :: evidence: ~~
[wat-00002] helpful=0 harmful=0 (range) :: WATCH: Thesis-confirmed trades in range regime consistently hit target with high MFE — consider raising takePct slightly to capture more edge. :: evidence: t001,t008,t010,t015,t016,t017,t018,t019
[wat-00003] helpful=0 harmful=0 (volatile) :: WATCH: Volatile regime trades show extreme MAE (t013: 3.08R) — stopPct may be too tight for volatile conditions, but filter is preferred over widening stop. :: evidence: t005,t007,t013,t014
