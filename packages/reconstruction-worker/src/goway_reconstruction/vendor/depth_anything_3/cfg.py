# Copyright (c) 2025 ByteDance Ltd. and/or its affiliates
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
Configuration utility functions

GoWay modification: OmegaConf is replaced by ``yaml.safe_load`` and plain
dicts. Only the features the vendored ``da3-base.yaml`` uses are kept (YAML
anchors and ``__object__`` construction ``as_params``); the global ``eval``
resolver, inheritance and dotlist overrides are removed. Objects are only ever
imported from inside this vendored package.
"""

import copy
import importlib
from pathlib import Path
from typing import Any

import yaml

_PACKAGE = __name__.rsplit(".", 1)[0]


def load_config(path: str | Path) -> dict:
    """Load a YAML configuration file into plain dicts and lists."""
    with open(path, encoding="utf-8") as handle:
        config = yaml.safe_load(handle)
    if not isinstance(config, dict):
        raise ValueError("model config must be a mapping")
    return config


def import_item(path: str, name: str) -> Any:
    """
    Import a python item. Example: import_item("path.to.file", "MyClass") -> MyClass
    """
    if path != _PACKAGE and not path.startswith(_PACKAGE + "."):
        raise ValueError(f"refusing to import {path!r} from a model config")
    return getattr(importlib.import_module(path), name)


def create_object(config: dict) -> Any:
    """
    Create an object from config.
    The config is expected to contains the following:
    __object__:
      path: path.to.module
      name: MyClass
      args: as_params
    """
    config = copy.deepcopy(dict(config))
    spec = config.pop("__object__")
    item = import_item(path=spec["path"], name=spec["name"])
    args = spec.get("args", "as_config")
    if args == "as_params":
        return item(**config)
    raise NotImplementedError(f"Unknown args type: {args}")
