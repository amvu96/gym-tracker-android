/* Bridges the ES-module MuscleMap engine into app.js, which is a classic
   (non-module) script and can't use `import` directly. Mirrors the same
   pattern already used for firebase-sync.js -> window.GymSync. */
import { MuscleMap } from './body/MuscleMap.js';

window.GymMuscleMap = MuscleMap;
