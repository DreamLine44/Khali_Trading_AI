"""Fail-closed inference for a diverse calibrated ensemble."""
from __future__ import annotations
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ai.common.model_loader import load_model, ModelNotAvailableError

_CLASS_TO_ACTION={"UP":"BUY","DOWN":"SELL","FLAT":"HOLD"}

def _aligned_meta_probability(model, X: np.ndarray) -> np.ndarray:
    p=model.predict_proba(X)
    classes=list(model.classes_)
    aligned=np.zeros((len(X),3),dtype=float)
    for i,cls in enumerate(("DOWN","FLAT","UP")):
        key = i if i in classes else cls
        if key in classes: aligned[:,i]=p[:,classes.index(key)]
    sums=aligned.sum(axis=1)
    if np.any(~np.isfinite(aligned)) or np.any(sums<=0):
        raise ModelNotAvailableError("meta-model returned invalid probabilities")
    return aligned/sums[:,None]

def predict(stage: str, symbol: str, timeframe: str, feature_row: dict[str,float], mode: str = "ensemble")->dict:
    bundle=load_model(stage,symbol,timeframe)
    models=bundle.get("models")
    if models is None: models=[bundle["model"]]
    meta_model=bundle.get("meta_model")
    cols=bundle["feature_columns"]
    missing=[c for c in cols if c not in feature_row]
    if missing: raise ValueError(f"feature row missing required columns: {missing}")
    invalid=[c for c in cols if not isinstance(feature_row[c],(int,float)) or not np.isfinite(feature_row[c])]
    if invalid: raise ValueError(f"feature row contains non-finite values: {invalid}")
    x=np.array([[feature_row[c] for c in cols]])
    if mode not in {"single", "ensemble", "hybrid"}:
        raise ValueError(f"unknown AI mode: {mode}")
    selected_models = models[:1] if mode == "single" else models
    if not selected_models:
        raise ModelNotAvailableError("no models available for selected AI mode")
    member=[]
    for model in selected_models:
        p=model.predict_proba(x)[0]
        classes=list(model.classes_)
        if not np.all(np.isfinite(p)) or np.any(p<0): raise ModelNotAvailableError("ensemble member returned invalid probabilities")
        aligned=np.zeros(3)
        for cls,val in zip(classes,p):
            key = ("DOWN","FLAT","UP")[int(cls)] if isinstance(cls, (int, np.integer)) else cls
            if key in _CLASS_TO_ACTION: aligned[["DOWN","FLAT","UP"].index(key)]=val
        if aligned.sum()<=0: raise ModelNotAvailableError("ensemble member returned no supported classes")
        member.append(aligned/aligned.sum())
    if mode == "ensemble" and meta_model is not None and len(member) > 1:
        meta_input=np.hstack([np.asarray(member[i]).reshape(1, -1) for i in range(len(member))])
        probs=_aligned_meta_probability(meta_model, meta_input)[0]
    else:
        probs=np.mean(member,axis=0)
    probs=probs/probs.sum()
    top=int(np.argmax(probs)); top_p=float(probs[top])
    entropy=-float(np.sum(probs*np.log(probs+1e-12))); uncertainty=float(np.clip(entropy/np.log(3),0,1))
    disagreement=float(np.mean([np.argmax(p)!=top for p in member]))
    uncertainty=float(np.clip(uncertainty*0.7+disagreement*0.3,0,1))
    actions=["SELL","HOLD","BUY"]
    return {"modelName":bundle["metadata"]["model_name"],"modelVersion":bundle["metadata"]["model_version"],"action":actions[top],"probability":top_p,"uncertainty":uncertainty,"classProbabilities":dict(zip(actions,probs.tolist())),"memberDisagreement":disagreement,"modelSource":bundle["metadata"]["training_data_source"],"mode":mode,"featureBaselineStats":bundle["metadata"].get("feature_baseline_stats")}

def main():
    if len(sys.argv) not in (4, 5): raise SystemExit("usage: prediction.py <stage> <symbol> <timeframe> [single|ensemble|hybrid]")
    mode = sys.argv[4] if len(sys.argv) == 5 else "ensemble"
    print(json.dumps(predict(sys.argv[1],sys.argv[2],sys.argv[3],json.loads(sys.stdin.read()), mode)))
if __name__=="__main__": main()
