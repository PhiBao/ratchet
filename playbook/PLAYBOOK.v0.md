# Ratchet Playbook v0

> Evolved context. Immutable — curation writes v1, never edits.
> Parent: genesis · seed
> Curation: genesis seed — conservative dip-buy priors. Every knob below is a hypothesis the loop will confirm, tighten, or retire with evidence.

## SETUPS

[set-00001] helpful=0 harmful=0 (trend, range) :: dip-buy: 24h drop between {dipPct}% and {maxDipPct}% with RSI under {rsiMax} buys pullbacks, not knives knobs: dipPct=3, maxDipPct=12, rsiPeriod=14, rsiMax=35 :: evidence: 

## FILTERS

[flt-00001] helpful=0 harmful=0 (volatile) :: skip dip-buys when the 24h range exceeds {volHiPct}% — wide ranges mean the dip has no floor yet knobs: volHiPct=6 :: evidence: 

[flt-00002] helpful=0 harmful=0 (unknown) :: no regime read, no trade — unknown is a verdict, not a gap to fill :: evidence: 

## EXITS

[exe-00001] helpful=0 harmful=0 (trend, range, volatile) :: exit mechanically: take {takePct}% or stop {stopPct}% or {maxHoldBars} bars, whichever prints first — lingering converts edge into noise knobs: takePct=2, stopPct=1.5, maxHoldBars=48 :: evidence: 

## SIZING

[siz-00001] helpful=0 harmful=0 (trend, range, volatile) :: risk 1% of equity per invalidation distance, capped at 25% notional — size from the stop, never from conviction :: evidence: 

## MISTAKES

[mis-00001] helpful=0 harmful=0 (trend, range, volatile) :: never reinforce a lucky win — a profit without thesis confirmation is a tax on future discipline :: evidence: 

## WATCH

[wat-00001] helpful=0 harmful=0 (unknown) :: do post-loss entries size up? watch: entries within 6 bars of a loss vs baseline :: evidence: 
