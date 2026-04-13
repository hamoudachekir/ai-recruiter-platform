from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf
import torch


def load_audio(path: str | Path, sample_rate: int = 16000) -> np.ndarray:
    audio, sr = sf.read(str(path), dtype="float32")

    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    if sr != sample_rate:
        import resampy

        audio = resampy.resample(audio, sr, sample_rate)

    return np.asarray(audio, dtype=np.float32)


def numpy_to_tensor(audio: np.ndarray) -> torch.Tensor:
    return torch.as_tensor(audio, dtype=torch.float32)


def tensor_to_numpy(tensor: torch.Tensor) -> np.ndarray:
    return tensor.detach().cpu().numpy()


def ms_to_samples(ms: int, sample_rate: int) -> int:
    return int(ms * sample_rate / 1000)


def samples_to_ms(samples: int, sample_rate: int) -> float:
    return samples / sample_rate * 1000.0