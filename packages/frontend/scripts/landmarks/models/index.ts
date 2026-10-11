/**
 * Every procedural landmark generator, by registry id. A registry entry whose
 * `model.generator` is set must be listed here (`build-landmarks.ts` fails
 * otherwise), and its file is the `generator` path the entry names.
 */
import { arcDeTriomf } from './arcDeTriomf';
import { casaBatllo } from './casaBatllo';
import { casaMila } from './casaMila';
import { chryslerBuilding } from './chryslerBuilding';
import { empireState } from './empireState';
import { flatironBuilding } from './flatironBuilding';
import { oneWorldTradeCenter } from './oneWorldTradeCenter';
import { palauNacional } from './palauNacional';
import { sagradaFamilia } from './sagradaFamilia';
import { statueOfLiberty } from './statueOfLiberty';
import { torreGlories } from './torreGlories';
import { wBarcelona } from './wBarcelona';
import type { LandmarkModel } from './types';

export const LANDMARK_MODELS: Readonly<Record<string, LandmarkModel>> = Object.fromEntries(
  [
    arcDeTriomf,
    casaBatllo,
    casaMila,
    chryslerBuilding,
    empireState,
    flatironBuilding,
    oneWorldTradeCenter,
    palauNacional,
    sagradaFamilia,
    statueOfLiberty,
    torreGlories,
    wBarcelona,
  ].map((model) => [model.id, model]),
);
