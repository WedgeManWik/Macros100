export interface Food {
  name: string;
  category: string;
  section: string;
  icon: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  nutrients: Record<string, number>;
  maxAmount: number;
  minAmount: number;
}

export interface DietDetails {
  weight: number;
  height: number;
  age: number;
  gender: 'male' | 'female';
  bodyFat: number;
  activityLevel: number;
  goal: string;
  maintenanceCalories?: number;
  calorieOffset?: number;
  macros?: {
    protein: MacroConfig;
    fat: MacroConfig;
    carbs: MacroConfig;
  };
  likedFoods?: string[];
  mustHaveFoods?: Array<{ name: string; min?: number; max?: number }>;
  algoModel?: 'beast' | 'titan' | 'olympian' | 'god';
  customRDAs?: Record<string, { target?: number, max?: number }>;
  advancedSettings?: boolean;
  strictCalories?: boolean;
}

export interface NutrientConfig {
  target: number;
  max: number;
  essential?: boolean;
  unit?: string;
}


export interface MacroConfig {
  mode: 'g/kg' | 'g' | '%' | 'remainder';
  value: number;
}

export interface ProgressUpdate {
  done: boolean;
  generation?: number;
  accuracy?: number;
  telemetry?: any;
  result?: any;
}
