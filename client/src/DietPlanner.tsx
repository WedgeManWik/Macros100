import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Joyride } from 'react-joyride';
const TourWrapper = (props: any) => {
  const J = Joyride as any;
  
  useEffect(() => {
    if (props.addLog) props.addLog('TourWrapper mounted. run: ' + props.run + ', J exists: ' + !!J);
    
    // Auto-click the beacon if it stubbornly appears despite disableBeacon flags
    if (props.run) {
      const clickBeacon = () => {
        const beacon = document.querySelector('button[title="Open the tour"], .__floater__open, [aria-label="Open the tour"], [type="button"][data-test-id="button-beacon"]') as HTMLElement;
        // fallback generic selector since Joyride changes classes
        const alternateBeacon = document.querySelector('div[style*="border-radius: 50%"]') as HTMLElement;
        
        if (beacon) beacon.click();
        else if (alternateBeacon) alternateBeacon.click();
      };
      const intervalId = setInterval(clickBeacon, 50);
      return () => clearInterval(intervalId);
    }
  }, [props.run]);

  if (!J) {
    if (props.addLog) props.addLog('ERROR: Joyride is completely undefined!');
    return null;
  }
  return <J {...props} />;
};
import { Container, Row, Col, Form, Button, Card, Alert, ProgressBar, Spinner, OverlayTrigger, Tooltip, Accordion } from 'react-bootstrap';
import { Calculator, Utensils, Target, Activity, Heart, Info, RotateCcw, ChevronLeft, ChevronRight, Settings, ClipboardList, X, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface Food {
  name: string;
  category: string;
  section: string;
  icon: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  nutrients: Record<string, number>;
  maxAmount?: number;
}

interface DietPlan {
  targetCalories: number;
  actualCalories: number;
  accuracy: number;
  macros: {
    protein: number;
    carbs: number;
    fat: number;
  };
  sectionedIngredients: Record<string, Array<{
    name: string;
    icon: string;
    amount: number;
    calories: number;
  }>>;
  micronutrients: Record<string, { 
    amount: number; 
    total: number; 
    unit: string; 
    sources: { food: string; amount: number; pctOfTotal: number }[]; 
    max?: number;
    target?: number;
    optimalMin?: number;
    optimalMax?: number;
    essential?: boolean;
  }>;
  error?: string;
}

interface FormData {
  weight: number;
  height: number;
  age: number;
  gender: 'male' | 'female';
  bodyFat: number;
  activityLevel: number;
  goal: 'maintain' | 'fast-lose' | 'moderate-lose' | 'moderate-gain' | 'fast-gain';
  mealsPerDay: number;
  likedFoods: string[];
  mustHaveFoods: Array<{ name: string, min?: number, max?: number, amount?: number }>;
  macros: {
    protein: { mode: string, value: number, strictness: 'strict' | 'relaxed' | 'none', strict?: boolean };
    fat: { mode: string, value: number, strictness: 'strict' | 'relaxed' | 'none', strict?: boolean };
    carbs: { mode: string, value: number, strictness: 'strict' | 'relaxed' | 'none', strict?: boolean };
  };
  customMacros: boolean;
  maintenanceCalories: number;
  calorieOffset: number;
  targetCalories: number;
  customMaxAmounts: Record<string, number>;
  algoModel: 'beast' | 'titan' | 'olympian' | 'god';
  advancedSettings: boolean;
  strictCalories: boolean;
  isBfCustom: boolean;
  customRDAs: Record<string, { target?: number, max?: number, essential?: boolean }>;
}

const InteractiveMacroPie = ({ 
  proteinPct, 
  fatPct, 
  onChange,
  onChangeStatus,
  targetCalories,
  weight,
  formData
}: { 
  proteinPct: number, 
  fatPct: number, 
  onChange: (p: number, f: number) => void,
  onChangeStatus: (macro: 'protein'|'fat'|'carbs', status: 'strict'|'none') => void,
  targetCalories: number,
  weight: number,
  formData: FormData
}) => {
  const radius = 80;
  const center = 100;
  const carbPct = Math.max(0, 1 - proteinPct - fatPct);

  const getCoordinatesForPercent = (percent: number) => {
    // Start at -90deg (12 o'clock)
    const x = center + radius * Math.cos(2 * Math.PI * percent - Math.PI / 2);
    const y = center + radius * Math.sin(2 * Math.PI * percent - Math.PI / 2);
    return [x, y];
  };

  const createPath = (startPct: number, endPct: number, color: string) => {
    const [startX, startY] = getCoordinatesForPercent(startPct);
    const [endX, endY] = getCoordinatesForPercent(endPct);
    const largeArcFlag = (endPct - startPct) > 0.5 ? 1 : 0;
    return `M ${center} ${center} L ${startX} ${startY} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${endX} ${endY} Z`;
  };

  const handlePointerMove = (e: React.PointerEvent, handleType: 'PF' | 'FC') => {
    const svg = (e.currentTarget as any).ownerSVGElement || e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left - center;
    const y = e.clientY - rect.top - center;
    
    let angle = Math.atan2(y, x) + Math.PI / 2;
    if (angle < 0) angle += 2 * Math.PI;
    const pct = angle / (2 * Math.PI);

    if (handleType === 'PF') {
      const newP = Math.min(0.9, Math.max(0.05, pct));
      const currentPFSum = proteinPct + fatPct;
      const newF = Math.max(0.05, Math.min(0.9, currentPFSum - newP));
      onChange(newP, newF);
    } else {
      const newPFSum = Math.min(0.95, Math.max(proteinPct + 0.05, pct));
      onChange(proteinPct, newPFSum - proteinPct);
    }
  };

  const pGrams = (proteinPct * targetCalories) / 4;
  const fGrams = (fatPct * targetCalories) / 9;
  const cGrams = (carbPct * targetCalories) / 4;

  return (
    <div className="macro-pie-container py-2 d-flex justify-content-center">
      <div style={{ width: '180px', height: '180px', position: 'relative', touchAction: 'none' }}>
        <svg viewBox="0 0 200 200" style={{ width: '100%', height: '100%' }}>
          <defs>
            <filter id="shadow">
              <feDropShadow dx="0" dy="0" stdDeviation="3" floodOpacity="0.5"/>
            </filter>
          </defs>
          {/* Fixed 12 o'clock line */}
          <line x1="100" y1="20" x2="100" y2="100" stroke="white" strokeWidth="1" strokeDasharray="4" opacity="0.3" />
          
          {/* Slices */}
          <path d={createPath(0, proteinPct, '#ff3131')} fill="#ff3131" opacity="0.8" />
          <path d={createPath(proteinPct, proteinPct + fatPct, '#ffea00')} fill="#ffea00" opacity="0.8" />
          <path d={createPath(proteinPct + fatPct, 1, '#3d9bff')} fill="#3d9bff" opacity="0.8" />
          
          {/* Handle 1: Protein-Fat */}
          <circle 
            cx={getCoordinatesForPercent(proteinPct)[0]} 
            cy={getCoordinatesForPercent(proteinPct)[1]} 
            r="10" fill="white" stroke="#ff3131" strokeWidth="3"
            style={{ cursor: 'grab', filter: 'url(#shadow)' }}
            onPointerMove={(e) => e.buttons === 1 && handlePointerMove(e, 'PF')}
            onPointerDown={(e) => (e.target as any).setPointerCapture(e.pointerId)}
          />
          
          {/* Handle 2: Fat-Carbs */}
          <circle 
            cx={getCoordinatesForPercent(proteinPct + fatPct)[0]} 
            cy={getCoordinatesForPercent(proteinPct + fatPct)[1]} 
            r="10" fill="white" stroke="#ffea00" strokeWidth="3"
            style={{ cursor: 'grab', filter: 'url(#shadow)' }}
            onPointerMove={(e) => e.buttons === 1 && handlePointerMove(e, 'FC')}
            onPointerDown={(e) => (e.target as any).setPointerCapture(e.pointerId)}
          />
          
          {/* Center Info */}
          <circle cx="100" cy="100" r="35" fill="var(--bg-card)" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
          <text x="100" y="98" textAnchor="middle" fill="#3d9bff" style={{ fontSize: '13px', fontWeight: 'bold', fontFamily: 'monospace' }}>{targetCalories}</text>
          <text x="100" y="112" textAnchor="middle" fill="gray" style={{ fontSize: '9px', fontWeight: 'bold' }}>KCAL</text>
        </svg>
      </div>
    </div>
  );
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';



const resultsSteps = [
  {
    target: 'body',
    placement: 'center',
    content: 'Your diet is ready! Here is your Ingredient List. You can edit the exact gram amounts, or click the Export button to copy the list to your clipboard.',
    disableBeacon: true,
  },
  {
    target: '.tour-result-2',
    content: 'Want this turned into a meal plan? Click Generate AI Meal Plan! You can enter Custom Instructions (like "I only want 3 meals" or "carb backloading") and our AI will organize your exact ingredients into perfect meals.',
    disableBeacon: true,
  },
  {
    target: '.tour-result-3',
    content: 'We also generate a complete Shopping List for all the ingredients you need!',
    disableBeacon: true,
  }
];

const DietPlanner = () => {
  const [showFoodModal, setShowFoodModal] = useState(false);
  const showFoodModalRef = useRef(false);
  useEffect(() => {
    showFoodModalRef.current = showFoodModal;
  }, [showFoodModal]);

  const formSteps = useMemo(() => [
    {
      target: 'body',
      placement: 'center',
      content: 'Welcome to Macros100! Let\'s walk through the app to get your perfect diet set up.',
      disableBeacon: true,
    },
    {
      target: '.tour-biometrics',
      content: 'First, enter your basic biometric details (Weight, Height, Age, and Gender) so we can accurately estimate your metabolic rate.',
      disableBeacon: true,
    },
    {
      target: '.tour-bodyfat',
      content: 'Next, enter your Body Fat percentage. If you don\'t know exactly what it is, don\'t worry! We will use a standard estimated amount based on your BMI.',
      disableBeacon: true,
    },
    {
      target: '.tour-activity',
      content: 'Select your daily Activity Level. Be honest—this heavily impacts your calorie needs.',
      disableBeacon: true,
    },
    {
      target: '.tour-maintenance',
      content: 'These are your calculated Maintenance Calories (the amount you need to stay exactly the same weight). You can manually adjust them here if you feel this amount is wrong based on your experience.',
      disableBeacon: true,
    },
    {
      target: '.tour-goal',
      content: 'Select your Daily Goal (Lose, Maintain, or Gain weight).',
      disableBeacon: true,
    },
    {
      target: '.tour-offset',
      content: 'This is the recommended Calorie Offset for your chosen goal (e.g. -500 calories for weight loss). You can change it if you wish.',
      disableBeacon: true,
    },
    {
      target: '.tour-target',
      content: 'Your final Target Calories are displayed here. You can manually type in a specific target here, and we will recalculate your offset automatically.',
      disableBeacon: true,
    },
    {
      target: '.tour-macros',
      content: 'By default, we use a recommended macro split. You can toggle the switch here to enable Custom Macros.',
      spotlightClicks: true,
      disableBeacon: true,
    },
    {
      target: '.tour-macros-pie',
      content: 'With Custom Macros enabled, you can click and manually drag the pie chart to perfectly adjust your Protein, Fat, and Carb ratios!',
      disableBeacon: true,
    },
    {
      target: '.tour-macros-strictness',
      content: 'The Strictness setting tells the AI how hard to try to hit these macros. "Strict" forces the math engine to hit that exact amount, while "Relaxed" gives it some wiggle room to make a tastier meal plan.',
      disableBeacon: true,
    },
    {
      target: '.tour-musthave',
      content: 'If there are foods you absolutely MUST eat every day (like 50g of whey protein), add them here and we will lock them into your diet.',
      disableBeacon: true,
    },
    {
      target: '.tour-advanced',
      content: 'Advanced users can open this panel to override micronutrient targets (like specific Vitamin C or Cholesterol limits).',
      disableBeacon: true,
    },
    {
      target: '.tour-liked',
      content: 'Now, click this button to open the Liked Foods menu! The algorithm will only pick foods from your liked list.',
      spotlightClicks: true,
      disableBeacon: true,
      styles: {
        buttonBack: {
          display: 'none'
        }
      }
    },
    {
      target: '.tour-liked-foods-modal-header',
      placement: 'top',
      content: 'This is the Liked Foods Menu! Here you can search, filter, and toggle foods you like or dislike. When you are done, close the menu to continue the tour.',
      disableBeacon: true,
      hideOverlay: true,
    },
    {
      target: '.tour-generate',
      content: 'Finally, click Generate Daily Plan to instantly create a scientifically perfect diet!',
      disableBeacon: true,
    }
  ], []);

  const [foods, setFoods] = useState<Food[]>([]);
  const [diet, setDiet] = useState<DietPlan | null>(null);
  const [originalDiet, setOriginalDiet] = useState<DietPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [joyrideLogs, setJoyrideLogs] = useState<string[]>(['Init']);
  
  const addLog = useCallback((msg: string) => {
    setJoyrideLogs(prev => {
        const newLogs = [...prev, new Date().toISOString().split('T')[1].substring(0, 8) + ' ' + msg];
        if (newLogs.length > 20) return newLogs.slice(newLogs.length - 20);
        return newLogs;
    });
  }, []);
  
  useEffect(() => {
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalLog = console.log;
    
    console.warn = (...args) => {
      addLog('WARN: ' + args.join(' '));
      originalWarn(...args);
    };
    console.error = (...args) => {
      addLog('ERROR: ' + args.join(' '));
      originalError(...args);
    };
    console.log = (...args) => {
      if (args[0] && typeof args[0] === 'string' && args[0].includes('joyride')) {
        addLog('LOG: ' + args.join(' '));
      }
      originalLog(...args);
    };

    return () => {
      console.warn = originalWarn;
      console.error = originalError;
      console.log = originalLog;
    };
  }, []);
  
  const [runTour, setRunTour] = useState(false);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const joyrideHelpers = useRef<any>(null);

  const [runResultsTour, setRunResultsTour] = useState(false);

  const handleJoyrideHelpers = useCallback((helpers: any) => {
    joyrideHelpers.current = helpers;
  }, []);

  const handleJoyrideCallback = useCallback((data: any) => {
    const { action, index, status, type } = data;
    addLog('Form Callback: status=' + status + ', type=' + type + ', action=' + action + ', index=' + index);
    console.log('Joyride event:', data);
    

    // Manual scroll engine to guarantee offset
    if (type === 'tooltip:update' && data.step?.target && data.step.target !== 'body') {
      setTimeout(() => {
        const targetEl = document.querySelector(data.step.target);
        const scrollParent = document.querySelector('.panel-left');
        if (targetEl && scrollParent) {
          const targetRect = targetEl.getBoundingClientRect();
          const parentRect = scrollParent.getBoundingClientRect();
          const offsetTop = targetRect.top - parentRect.top + scrollParent.scrollTop;
          scrollParent.scrollTo({ top: Math.max(0, offsetTop - 250), behavior: 'smooth' });
        }
      }, 50);
    }

    if (type === 'step:after' || type === 'error:target_not_found') {
      const isNext = action === 'next';
      const isPrev = action === 'prev';
      
      if (index === 13 && isNext) {
        addLog('Step 13 Next triggered. Opening modal.');
        setShowFoodModal(true);
        setTimeout(() => {
          addLog('Timeout finished. Advancing to step 14.');
          setCurrentStepIndex(14);
        }, 150);
      } else if (index === 15 && isPrev) {
        addLog('Step 15 Back triggered. Opening modal.');
        setShowFoodModal(true);
        setTimeout(() => {
          addLog('Timeout finished. Returning to step 14.');
          setCurrentStepIndex(14);
        }, 150);
      } else if (index === 14) {
        addLog('Step 14 action: ' + action);
        setShowFoodModal(false);
        if (isNext) {
          setCurrentStepIndex(15);
        } else if (isPrev) {
          setCurrentStepIndex(13);
        }
      } else {
        const nextStep = index + (isPrev ? -1 : 1);
        addLog('Default transition: from ' + index + ' to ' + nextStep);
        setCurrentStepIndex(nextStep);
      }
    }

    if (status === 'finished' || status === 'skipped' || action === 'close') {
      addLog('Tour ended. status=' + status);
      setRunTour(false);
      setCurrentStepIndex(0);
      setShowFoodModal(false);
      localStorage.setItem('macros100_tutorial_done', 'true');
    }
  }, [addLog]);

  const handleResultsJoyrideCallback = useCallback((data: any) => {
    const { action, status, type } = data;
    addLog('Results Callback: status=' + status + ', type=' + type + ', action=' + action);
    if (status === 'finished' || status === 'skipped' || action === 'close') {
      setRunResultsTour(false);
      localStorage.setItem('macros100_results_tutorial_done', 'true');
    }
  }, [addLog]);

  const [isEditing, setIsEditing] = useState(false);
  
  const [mealPlan, setMealPlan] = useState<string | null>(null);
  const [mealPlanLoading, setMealPlanLoading] = useState(false);
  const [mealPlanError, setMealPlanError] = useState<string | null>(null);
  const [customInstructions, setCustomInstructions] = useState('');

  const [formData, setFormData] = useState<FormData>(() => {
    const defaults: FormData = {
        weight: 70,
        height: 175,
        age: 25,
        gender: 'male',
        bodyFat: 15,
        activityLevel: 1.55,
        goal: 'maintain',
        mealsPerDay: 3,
        likedFoods: [],
        mustHaveFoods: [],
        macros: {
            protein: { mode: 'g/kg', value: 2.2, strict: true, strictness: 'strict' },
            fat: { mode: 'g/kg', value: 1.0, strict: false, strictness: 'none' },
            carbs: { mode: 'remainder', value: 0, strict: false, strictness: 'none' }
        },
        customMacros: false,
        maintenanceCalories: 2500,
        calorieOffset: 0,
        targetCalories: 2500,
        customMaxAmounts: {},
        algoModel: 'beast',
        advancedSettings: false,
        strictCalories: true,
        isBfCustom: false,
        customRDAs: {}
    };
    try {
        const saved = localStorage.getItem('macros100_profile');
        if (saved) {
            const parsed = JSON.parse(saved);
            return { ...defaults, ...parsed };
        }
    } catch (e) {
        // Fallback to defaults
    }
    return defaults;
  });

  const [showRDAModal, setShowRDAModal] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  // Estimate Body Fat if not custom
  useEffect(() => {
    if (formData.isBfCustom) return;
    
    const heightM = formData.height / 100;
    if (heightM <= 0) return;
    
    const bmi = formData.weight / (heightM * heightM);
    const genderVal = formData.gender === 'male' ? 1 : 0;
    // BF% = (1.20 × BMI) + (0.23 × Age) − (10.8 × gender) − 5.4
    let estimatedBf = (1.20 * bmi) + (0.23 * formData.age) - (10.8 * genderVal) - 5.4;
    
    // Clamp to realistic ranges
    estimatedBf = Math.max(formData.gender === 'male' ? 3 : 8, Math.min(estimatedBf, 60));
    const roundedBf = Math.round(estimatedBf * 10) / 10;
    
    if (formData.bodyFat !== roundedBf) {
      setFormData(prev => ({ ...prev, bodyFat: roundedBf }));
    }
  }, [formData.weight, formData.height, formData.age, formData.gender, formData.isBfCustom]);

  const getGoalFromOffset = (offset: number) => {
    if (offset <= -500) return 'fast-lose';
    if (offset <= -250) return 'moderate-lose';
    if (offset >= 500) return 'fast-gain';
    if (offset >= 250) return 'moderate-gain';
    return 'maintain';
  };

  const getOffsetFromGoal = (goal: string) => {
    switch (goal) {
      case 'fast-lose': return -500;
      case 'moderate-lose': return -250;
      case 'moderate-gain': return 250;
      case 'fast-gain': return 500;
      default: return 0;
    }
  };

  // Calculate Maintenance & Target Calories on biometric change
  useEffect(() => {
    const lbm = formData.weight * (1 - (formData.bodyFat / 100));
    const bmr = 370 + (21.6 * lbm);
    const maintenance = Math.round(bmr * formData.activityLevel);
    
    setFormData(prev => {
        if (prev.maintenanceCalories !== maintenance) {
            return { 
              ...prev, 
              maintenanceCalories: maintenance, 
              targetCalories: maintenance + prev.calorieOffset 
            };
        }
        return prev;
    });
  }, [formData.weight, formData.bodyFat, formData.activityLevel]);

  // Handle Dynamic Macro Goals
  useEffect(() => {
    if (formData.customMacros) return;

    const targetCals = formData.maintenanceCalories + formData.calorieOffset;
    const isLowCal = targetCals < 1500;
    const isGain = formData.goal.includes('gain');
    const isLoss = formData.goal.includes('lose');

    setFormData(prev => {
        const newMacros = { ...prev.macros };
        
        if (isLowCal) {
            newMacros.protein = { ...newMacros.protein, mode: '%', value: 30 };
            newMacros.fat = { ...newMacros.fat, mode: '%', value: 25 };
        } else if (isGain) {
            newMacros.protein = { ...newMacros.protein, mode: 'g/kg', value: 2.2 };
            newMacros.fat = { ...newMacros.fat, mode: '%', value: 30 };
        } else if (isLoss) {
            newMacros.protein = { ...newMacros.protein, mode: 'g/kg', value: 1.8 };
            newMacros.fat = { ...newMacros.fat, mode: '%', value: 25 };
        } else {
            // Maintenance
            newMacros.protein = { ...newMacros.protein, mode: 'g/kg', value: 1.6 };
            newMacros.fat = { ...newMacros.fat, mode: '%', value: 30 };
        }
        newMacros.carbs = { ...newMacros.carbs, mode: 'remainder', value: 0 };

        // Check if actually changed to avoid infinite loop
        if (JSON.stringify(prev.macros) === JSON.stringify(newMacros)) return prev;
        return { ...prev, macros: newMacros };
    });
  }, [formData.goal, formData.maintenanceCalories, formData.calorieOffset, formData.customMacros, formData.weight]);

  const addMustHave = (name: string) => {
    if (formData.mustHaveFoods.find(f => f.name === name)) return;
    setFormData(prev => ({
      ...prev,
      mustHaveFoods: [...prev.mustHaveFoods, { name, min: 100, max: 150 }]
    }));
  };

  const removeMustHave = (name: string) => {
    setFormData(prev => ({
      ...prev,
      mustHaveFoods: prev.mustHaveFoods.filter(f => f.name !== name)
    }));
  };

  const updateMustHaveRange = (name: string, field: 'min' | 'max', value: number) => {
    setFormData(prev => ({
      ...prev,
      mustHaveFoods: prev.mustHaveFoods.map(f => f.name === name ? { ...f, [field]: value } : f)
    }));
  };

  const updateCustomMax = (foodName: string, max: number) => {
    setFormData(prev => ({
      ...prev,
      customMaxAmounts: { ...prev.customMaxAmounts, [foodName]: max }
    }));
  };

  const copyProfile = () => {
    const profile = JSON.stringify(formData);
    navigator.clipboard.writeText(profile);
    alert('Profile copied to clipboard!');
  };

  const pasteProfile = async () => {
    try {
        const text = await navigator.clipboard.readText();
        const data = JSON.parse(text);
        
        // Filter liked foods and must-have foods against current database
        const validFoodNames = foods.map(f => f.name);
        const filteredLiked = (data.likedFoods || []).filter((name: string) => validFoodNames.includes(name));
        const filteredMust = (data.mustHaveFoods || []).filter((m: any) => validFoodNames.includes(m.name));

        setFormData(prev => ({ 
            ...prev, 
            customRDAs: {}, 
            ...data,
            macros: { ...prev.macros, ...(data.macros || {}) },
            mustHaveFoods: filteredMust,
            likedFoods: filteredLiked
        }));
        alert('Profile loaded and verified successfully!');
    } catch (err) {
        alert('Failed to parse profile from clipboard.');
    }
  };

  // LOAD FOODS AND PROFILE
  useEffect(() => {
    const loadData = async () => {
      try {
        console.log('Macros100: Fetching foods from /api/foods');
        const res = await fetch('/api/foods');

        if (!res.ok) {
            const errorText = await res.text();
            console.error(`Macros100: API Error ${res.status}:`, errorText);
            setError(`API Error ${res.status}: ${errorText}`);
            return;
        }

        const loadedFoods = await res.json();
        console.log(`Macros100: Loaded ${loadedFoods.length} items.`);
        setFoods(loadedFoods);

        const validNames = loadedFoods.map((f: any) => f.name);
        
        const savedProfileStr = localStorage.getItem('macros100_profile');
        if (savedProfileStr) {
            const savedProfile = JSON.parse(savedProfileStr);
            
            // Filter persistence data against current database
            if (savedProfile.likedFoods) {
                savedProfile.likedFoods = savedProfile.likedFoods.filter((n: string) => validNames.includes(n));
            }
            if (savedProfile.mustHaveFoods) {
                savedProfile.mustHaveFoods = savedProfile.mustHaveFoods
                    .filter((m: any) => validNames.includes(m.name))
                    .map((m: any) => {
                        if (m.amount !== undefined && m.min === undefined) {
                            return { ...m, min: m.amount, max: m.amount + 50 }; 
                        }
                        return m;
                    });
            }

            setFormData(prev => ({ ...prev, ...savedProfile }));
        } else {
            setFormData(prev => ({ ...prev, likedFoods: loadedFoods.map((f: any) => f.name) }));
        }
      } catch (err) {
        console.error('Error fetching data:', err);
        setError('Failed to load initial data.');
      }
    };
    loadData();
  }, []);

  // AUTO-SAVE PROFILE (Debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
        localStorage.setItem('macros100_profile', JSON.stringify(formData));
    }, 1000); 
    return () => clearTimeout(timer);
  }, [formData]);

  const handleInputChange = (e: React.ChangeEvent<any>) => {
    const { name, value } = e.target;
    let val = (name === 'gender' || name === 'goal' || name === 'algoModel') ? value : parseFloat(value);
    
    // Handle empty/invalid numeric inputs
    if (typeof val === 'number' && isNaN(val)) {
        val = 0;
    }
    
    setFormData(prev => {
      const updated = { ...prev, [name]: val };
      if (name === 'bodyFat') updated.isBfCustom = true;
      
      if (name === 'goal') {
        updated.calorieOffset = getOffsetFromGoal(val as string);
        updated.targetCalories = prev.maintenanceCalories + updated.calorieOffset;
      } else if (name === 'calorieOffset') {
        updated.goal = getGoalFromOffset(val as number);
        updated.targetCalories = prev.maintenanceCalories + (val as number);
      } else if (name === 'targetCalories') {
        updated.calorieOffset = (val as number) - prev.maintenanceCalories;
        updated.goal = getGoalFromOffset(updated.calorieOffset);
      } else if (name === 'maintenanceCalories') {
        updated.targetCalories = (val as number) + prev.calorieOffset;
      }
      
      return updated;
    });
  };

  const handleMacroChange = (macro: 'protein'|'fat'|'carbs', field: 'mode'|'value'|'strictness'|'strict', val: any) => {
    setFormData(prev => {
      const newMacros = { ...prev.macros };
      const currentMacro = { ...newMacros[macro], [field]: field === 'value' ? (parseFloat(val) || 0) : val };
      
      // 1. If strictness is set to 'none', mode MUST be 'remainder'
      if (field === 'strictness' && val === 'none') {
        currentMacro.mode = 'remainder';
        currentMacro.value = 0;
      }
      
      // 2. If mode is set to 'remainder', ensure no other macro is 'remainder'
      if (field === 'mode' && val === 'remainder') {
        Object.keys(newMacros).forEach(m => {
          if (m !== macro && newMacros[m as 'protein'|'fat'|'carbs'].mode === 'remainder') {
            newMacros[m as 'protein'|'carbs'|'fat'].mode = m === 'fat' ? '%' : 'g';
            newMacros[m as 'protein'|'carbs'|'fat'].value = m === 'fat' ? 30 : 150;
          }
        });
      }

      newMacros[macro] = currentMacro;

      // 3. Ensure at least one macro is 'remainder'
      const remainderMacro = Object.keys(newMacros).find(m => newMacros[m as 'protein'|'fat'|'carbs'].mode === 'remainder');
      if (!remainderMacro) {
          newMacros.carbs.mode = 'remainder';
          newMacros.carbs.value = 0;
      }

      return { ...prev, macros: newMacros };
    });
  };

  const updateCustomRDA = (key: string, field: string, value: any) => {
    setFormData(prev => ({
      ...prev,
      customRDAs: {
        ...prev.customRDAs,
        [key]: {
          ...(prev.customRDAs[key] || {}),
          [field]: value
        }
      }
    }));
  };

  const revertNutrient = (key: string) => {
    setFormData(prev => {
      const updated = { ...prev.customRDAs };
      delete updated[key];
      return { ...prev, customRDAs: updated };
    });
  };

  const getDefaultNutrientConfig = (key: string) => {
    const isMale = formData.gender === 'male';
    const weight = formData.weight;
    const targetCals = formData.targetCalories;
    
    // Logic mirrored from nutrition.ts
    const configs: Record<string, { target: number, max: number, essential: boolean, unit?: string }> = {
        energy: { target: targetCals, max: targetCals + 50, essential: false },
        water: { target: isMale ? 3700 : 2700, max: 10000, essential: false },
        fiber: { target: isMale ? 38 : 25, max: 100, essential: true },
        sugars: { target: (targetCals * 0.05) / 4, max: (targetCals * 0.20) / 4, essential: false },
        omega3: { target: isMale ? 1.6 : 1.1, max: 10, essential: true },
        omega6: { target: isMale ? 17 : 12, max: 40, essential: true },
        cholesterol: { target: 300, max: 600, essential: true },
        b1: { target: isMale ? 1.2 : 1.1, max: 100, essential: true },
        b2: { target: isMale ? 1.3 : 1.1, max: 100, essential: true },
        b3: { target: isMale ? 16 : 14, max: 35, essential: true },
        b5: { target: 5, max: 100, essential: true },
        b6: { target: 1.7, max: 100, essential: true },
        b12: { target: 2.4, max: 100, essential: true },
        folate: { target: 400, max: 1000, essential: true },
        a: { target: isMale ? 900 : 700, max: 3000, unit: 'mcg', essential: true },
        c: { target: isMale ? 90 : 75, max: 2000, unit: 'mg', essential: true },
        d: { target: 800, max: 4000, unit: 'IU', essential: false },
        e: { target: 15, max: 1000, unit: 'mg', essential: true },
        k: { target: isMale ? 120 : 90, max: 1000, essential: true },
        biotin: { target: 30, max: 100, unit: 'mcg', essential: true },
        choline: { target: isMale ? 550 : 425, max: 3500, unit: 'mg', essential: true },
        calcium: { target: 1000, max: 2500, essential: true },
        copper: { target: 0.9, max: 10, essential: true },
        iron: { target: isMale ? 8 : 18, max: 45, essential: true },
        magnesium: { target: isMale ? 420 : 320, max: 1000, essential: true },
        manganese: { target: isMale ? 2.3 : 1.8, max: 11, essential: true },
        phosphorus: { target: 700, max: 4000, essential: true },
        potassium: { target: isMale ? 3400 : 2600, max: 10000, essential: true },
        selenium: { target: 55, max: 400, essential: true },
        sodium: { target: formData.age > 60 ? 1500 : 2300, max: formData.age > 60 ? 2300 : 3000, essential: true },
        zinc: { target: isMale ? 11 : 8, max: 40, essential: true },
        iodine: { target: 150, max: 1100, unit: 'mcg', essential: true },
        fluoride: { target: isMale ? 4 : 3, max: 10, unit: 'mg', essential: true },
        boron: { target: 3, max: 20, unit: 'mg', essential: true },
        chromium: { target: isMale ? 35 : 25, max: 200, unit: 'mcg', essential: true },
        molybdenum: { target: 45, max: 2000, unit: 'mcg', essential: true },
        chloride: { target: 2300, max: 3600, unit: 'mg', essential: true },
        betaine: { target: 1500, max: 5000, unit: 'mg', essential: false },
        lutein_zeaxanthin: { target: 10000, max: 20000, unit: 'mcg', essential: false },
        lycopene: { target: 15000, max: 30000, unit: 'mcg', essential: false },
        quercetin: { target: 25, max: 500, unit: 'mg', essential: false },
        anthocyanins: { target: 50, max: 1000, unit: 'mg', essential: false },
        cystine: { target: weight * 6, max: 5000, essential: true },
        histidine: { target: weight * 14, max: 5000, essential: true },
        isoleucine: { target: weight * 19, max: 10000, essential: true },
        leucine: { target: weight * 42, max: 20000, essential: true },
        lysine: { target: weight * 38, max: 15000, essential: true },
        methionine: { target: weight * 13, max: 5000, essential: true },
        phenylalanine: { target: weight * 14, max: 10000, essential: true },
        threonine: { target: weight * 20, max: 10000, essential: true },
        tryptophan: { target: weight * 5, max: 2000, essential: true },
        tyrosine: { target: weight * 19, max: 10000, essential: true },
        valine: { target: weight * 24, max: 12000, essential: true },
        arginine: { target: weight * 30, max: 20000, essential: true },
        glutamine: { target: 5000, max: 30000, essential: false },
        glycine: { target: weight * 45, max: 20000, essential: true },
        proline: { target: 2000, max: 15000, essential: false }
    };

    if (configs[key]) return configs[key];
    
    // Macro fallbacks (approximate for display)
    if (key === 'protein') return { target: 2.2 * weight, max: 4.4 * weight, essential: true };
    if (key === 'carbs') return { target: 300, max: 600, essential: false };
    if (key === 'net_carbs') return { target: 250, max: 500, essential: false };
    if (key === 'fat') return { target: 70, max: 140, essential: false };
    if (key.includes('fat')) return { target: targetCals * 0.1 / 9, max: targetCals * 0.15 / 9, essential: true };

    return { target: 0, max: 0, essential: false };
  };

  const nutrientGroups = [ 
    { title: "General", keys: ["water"] },
    { title: "Carbohydrates", keys: ["fiber", "sugars", "net_carbs"] },
    { title: "Lipids", keys: ["cholesterol", "fatMono", "fatPoly", "omega3", "omega6", "fatSat", "fatTrans"] },
    { title: "Protein (Amino Acids)", keys: ["cystine", "histidine", "isoleucine", "leucine", "lysine", "methionine", "phenylalanine", "threonine", "tryptophan", "tyrosine", "valine", "arginine", "glutamine", "glycine", "proline"] },
    { title: "Vitamins", keys: ["b1", "b2", "b3", "b5", "b6", "b12", "folate", "a", "c", "d", "e", "k", "biotin", "choline"] },
    { title: "Minerals", keys: ["calcium", "copper", "iron", "magnesium", "manganese", "phosphorus", "potassium", "selenium", "sodium", "zinc", "iodine", "fluoride", "boron", "chromium", "molybdenum", "chloride"] },
    { title: "Phytonutrients & Other", keys: ["betaine", "lutein_zeaxanthin", "lycopene", "quercetin", "anthocyanins"] }
  ];

  const [foodSearch, setFoodSearch] = useState('');
  const closeFoodModal = useCallback(() => {
    setShowFoodModal(false);
    if (runTour) {
      setCurrentStepIndex(15);
    }
  }, [runTour]);
  const [shouldWiggle, setShouldWiggle] = useState(false);

  const toggleFood = (foodName: string) => {
    setFormData(prev => ({
      ...prev,
      likedFoods: prev.likedFoods.includes(foodName)
        ? prev.likedFoods.filter(f => f !== foodName)
        : [...prev.likedFoods, foodName]
    }));
  };

  const [progress, setProgress] = useState({ 
    generation: 0, 
    accuracy: 0, 
    time: 0,
    telemetry: {
        calories: 0,
        fat: 0,
        worstNutrient: '',
        worstPct: 0,
        metCount: 0,
        totalEssential: 0,
        score: 0,
        avgAccuracy: 0,
        trialInfo: '',
        islands: [] as number[][]
    }
  });

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    // VALIDATION: Check for at least 5 unique foods
    const mustHaveNames = (formData.mustHaveFoods || []).map((m: any) => m.name);
    const uniqueFoodNames = new Set([...formData.likedFoods, ...mustHaveNames]);
    
    if (uniqueFoodNames.size < 5) {
        setError("You need to select more foods! Please pick at least 5 different foods to allow the algorithm to find a balanced combination.");
        setShouldWiggle(true);
        setTimeout(() => setShouldWiggle(false), 500);
        return;
    }

    // MOBILE IMMEDIATE SWITCH: Show loading on Results tab immediately
    if (window.innerWidth < 992) {
        setIsSidebarCollapsed(true);
    }

    setLoading(true);
    setDiet(null);
    setError(null);
    setProgress({ 
        generation: 0, 
        accuracy: 0, 
        time: 0,
        telemetry: { calories: 0, fat: 0, worstNutrient: '', worstPct: 0, metCount: 0, totalEssential: 0, score: 0, avgAccuracy: 0, trialInfo: '', islands: [] }
    });

    try {
      const startRes = await fetch(`${API_BASE_URL}/api/start-generation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      const data = await startRes.json();
      const jobId = data.jobId;

      const startTime = Date.now();
      const interval = setInterval(async () => {
        try {
            const statusRes = await fetch(`${API_BASE_URL}/api/status/${jobId}`);
            const status = await statusRes.json();
            
            setProgress({
                generation: status.generation,
                accuracy: status.currentAccuracy,
                time: Math.round((Date.now() - startTime) / 1000),
                telemetry: status.telemetry || progress.telemetry
            });

            if (status.status === 'completed') {
                clearInterval(interval);
                if (status.result) {
                    setDiet(status.result);
                    setOriginalDiet(JSON.parse(JSON.stringify(status.result)));
                    
                    // MOBILE AUTO-SWITCH: Switch to Results tab on small screens
                    if (window.innerWidth < 992) {
                        setIsSidebarCollapsed(true);
                        setTimeout(() => {
                            const resultsEl = document.querySelector('.panel-right');
                            resultsEl?.scrollTo({ top: 0, behavior: 'smooth' });
                        }, 300);
                    }

                    // If it's a best-effort result, the worker passes the error inside the result
                    if (status.result.error) {
                        // We don't set the main 'error' state here because that shows the big red box
                        // and might hide the diet. The yellow notice inside the diet view will handle it.
                        console.log("Optimization Notice:", status.result.error);
                    }
                }
                setLoading(false);
            }
            else if (status.status === 'failed' || status.status === 'cancelled') {
                clearInterval(interval);
                // This is a total failure (no diet generated at all)
                const finalError = status.error || 'The optimization algorithm could not find a valid diet passing all quality checks. Please adjust your constraints or select more foods.';
                setError(finalError);
                setLoading(false);
            }
        } catch (err) { console.error(err); }
      }, 500);
    } catch (err: any) {
      setError('Failed: ' + err.message);
      setLoading(false);
    }
  };

  const cancelGeneration = () => { setLoading(false); };

  const calculateNutrientsFromIngredients = (sectionedIngredients: DietPlan['sectionedIngredients'], currentMicros: DietPlan['micronutrients']): Pick<DietPlan, 'actualCalories' | 'macros' | 'micronutrients' | 'accuracy'> => {
    const flatIngredients: Record<string, number> = {};
    Object.values(sectionedIngredients).flat().forEach(i => {
        flatIngredients[i.name] = (flatIngredients[i.name] || 0) + i.amount;
    });

    const newMicros: any = JSON.parse(JSON.stringify(currentMicros || {}));
    Object.keys(newMicros).forEach(k => {
        newMicros[k].amount = 0;
        newMicros[k].total = 0;
        newMicros[k].sources = [];
    });

    Object.entries(flatIngredients).forEach(([name, amount]) => {
        const food = foods.find(f => f.name === name);
        const r = amount / 100;

        if (food) {
            if (newMicros.energy) {
                const contrib = r * food.calories;
                newMicros.energy.amount += contrib;
            }
            if (newMicros.protein) newMicros.protein.amount += r * food.protein;
            if (newMicros.carbs) newMicros.carbs.amount += r * food.carbs;
            if (newMicros.fat) newMicros.fat.amount += r * food.fat;

            Object.keys(newMicros).forEach(k => {
                if (k === 'energy' || k === 'protein' || k === 'carbs' || k === 'fat') return;
                const val = food.nutrients ? food.nutrients[k] : 0;
                if (val) {
                    const contrib = r * val;
                    newMicros[k].amount += contrib;
                    if (contrib > 0.001) {
                        newMicros[k].sources.push({ food: name, amount: contrib, pctOfTotal: 0 });
                    }
                }
            });
        }
    });

    const aminoAcids = ['cystine', 'histidine', 'isoleucine', 'leucine', 'lysine', 'methionine', 'phenylalanine', 'threonine', 'tryptophan', 'tyrosine', 'valine', 'arginine', 'glutamine', 'glycine', 'proline'];
    Object.keys(newMicros).forEach(k => {
        const config = getDefaultNutrientConfig(k);
        const serverTarget = currentMicros[k]?.target;
        const target = (serverTarget !== undefined && serverTarget > 0) ? serverTarget : config.target;
        const isAmino = aminoAcids.includes(k);
        
        // Finalize units
        newMicros[k].unit = config.unit || (isAmino ? 'g' : (['energy'].includes(k) ? 'kcal' : ['protein', 'carbs', 'fat', 'fiber', 'sugars', 'water', 'omega3', 'omega6', 'fatSat', 'fatPoly', 'fatMono'].includes(k) ? 'g' : ['b12', 'folate', 'a', 'k', 'selenium'].includes(k) ? 'mcg' : 'mg'));
        
        // Calculate pctOfTotal for sources before rounding the total amount
        const rawAmount = newMicros[k].amount;
        newMicros[k].sources.forEach((s: any) => {
            s.pctOfTotal = rawAmount > 0 ? Math.round((s.amount / rawAmount) * 100) : 0;
            if (isAmino) s.amount = Math.round(s.amount) / 1000; // mg to g
            else s.amount = Math.round(s.amount * 100) / 100;
        });
        newMicros[k].sources.sort((a: any, b: any) => b.pctOfTotal - a.pctOfTotal);

        // Round total amount exactly like the server
        if (isAmino) newMicros[k].amount = Math.round(rawAmount) / 1000;
        else newMicros[k].amount = Math.round(rawAmount * 100) / 100;

        if (target > 0) {
            newMicros[k].total = Math.round(((isAmino ? newMicros[k].amount * 1000 : newMicros[k].amount) / target) * 100);
        } else {
            newMicros[k].total = 100;
        }
    });

    // Mirror server's accuracy logic exactly
    const essentialKeys = Object.keys(newMicros).filter(k => (currentMicros[k] as any)?.essential === true);
    let totalSat = 0;
    essentialKeys.forEach(k => { 
        totalSat += Math.min(1.0, (newMicros[k].total || 0) / 100); 
    });
    const accuracy = Math.round((totalSat / essentialKeys.length) * 1000) / 10;

    return {
        actualCalories: Math.round(newMicros.energy?.amount || 0),
        accuracy,
        macros: {
            protein: Math.round(newMicros.protein?.amount || 0),
            carbs: Math.round(newMicros.carbs?.amount || 0),
            fat: Math.round(newMicros.fat?.amount || 0)
        },
        micronutrients: newMicros
    };
  };

  const handleGenerateMealPlan = async () => {
    if (!diet) return;
    setMealPlanLoading(true);
    setMealPlanError(null);
    try {
      const ingredients = [];
      for (const section of Object.values(diet.sectionedIngredients)) {
        for (const item of section) {
           ingredients.push({ name: item.name, grams: item.amount });
        }
      }
      
      const res = await fetch(`${API_BASE_URL}/api/generate-meal-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ingredients, customInstructions })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate meal plan');
      
      setMealPlan(data.mealPlan);
    } catch (err: any) {
      setMealPlanError(err.message);
    } finally {
      setMealPlanLoading(false);
    }
  };

  const handleAmountChange = (section: string, index: number, newAmount: string) => {
    if (!diet) return;
    const amt = parseFloat(newAmount) || 0;
    
    setDiet(prev => {
        if (!prev) return null;
        const newSectioned = JSON.parse(JSON.stringify(prev.sectionedIngredients));
        newSectioned[section][index].amount = amt;
        
        const food = foods.find(f => f.name === newSectioned[section][index].name);
        if (food) {
            newSectioned[section][index].calories = Math.round((amt / 100) * food.calories);
        }

        const updatedStats = calculateNutrientsFromIngredients(newSectioned, prev.micronutrients);
        return {
            ...prev,
            ...updatedStats,
            sectionedIngredients: newSectioned
        };
    });
  };

  const [showAddIngredientModal, setShowAddIngredientModal] = useState<{ section: string } | null>(null);

  const removeIngredient = (section: string, index: number) => {
    if (!diet) return;
    setDiet(prev => {
        if (!prev) return null;
        const newSectioned = JSON.parse(JSON.stringify(prev.sectionedIngredients));
        newSectioned[section].splice(index, 1);
        if (newSectioned[section].length === 0) delete newSectioned[section];

        const updatedStats = calculateNutrientsFromIngredients(newSectioned, prev.micronutrients);
        return {
            ...prev,
            ...updatedStats,
            sectionedIngredients: newSectioned
        };
    });
  };

  const revertFood = (section: string, index: number) => {
    if (!originalDiet || !diet) return;
    const originalItem = originalDiet.sectionedIngredients[section]?.[index];
    if (!originalItem) return;

    setDiet(prev => {
        if (!prev) return null;
        const newSectioned = JSON.parse(JSON.stringify(prev.sectionedIngredients));
        newSectioned[section][index].amount = originalItem.amount;
        
        const food = foods.find(f => f.name === newSectioned[section][index].name);
        if (food) {
            newSectioned[section][index].calories = Math.round((originalItem.amount / 100) * food.calories);
        }

        const updatedStats = calculateNutrientsFromIngredients(newSectioned, prev.micronutrients);
        return {
            ...prev,
            ...updatedStats,
            sectionedIngredients: newSectioned
        };
    });
  };

  const revertToOriginal = () => {
    if (originalDiet) {
        setDiet(JSON.parse(JSON.stringify(originalDiet)));
        setIsEditing(false);
    }
  };

  const addIngredient = (section: string, foodName: string, amount: number) => {
    if (!diet) return;
    const food = foods.find(f => f.name === foodName);
    if (!food) return;

    setDiet(prev => {
        if (!prev) return null;
        const newSectioned = JSON.parse(JSON.stringify(prev.sectionedIngredients));
        if (!newSectioned[section]) newSectioned[section] = [];
        
        newSectioned[section].push({
            name: food.name,
            icon: food.icon,
            amount: amount,
            calories: Math.round((amount / 100) * food.calories)
        });

        const updatedStats = calculateNutrientsFromIngredients(newSectioned, prev.micronutrients);
        return {
            ...prev,
            ...updatedStats,
            sectionedIngredients: newSectioned
        };
    });
    setShowAddIngredientModal(null);
  };

  const getConversion = (name: string, amount: number) => {
    const n = name.toLowerCase();
    
    // Exact juices
    if (n.includes('juice')) {
        if (n.includes('lemon')) return `~${(amount / 45).toFixed(1)} squeezed lemons`;
        if (n.includes('lime')) return `~${(amount / 30).toFixed(1)} squeezed limes`;
        return null; // Don't give "apple" units to "apple juice"
    }

    // Units
    if (n.includes('egg') && !n.includes('white')) return `~${(amount / 50).toFixed(1)} units`;
    if (n.includes('egg white')) return `~${(amount / 30).toFixed(1)} large egg whites`;
    if (n.includes('apple')) return `~${(amount / 180).toFixed(1)} medium apples`;
    if (n.includes('banana')) return `~${(amount / 120).toFixed(1)} medium bananas`;
    if (n.includes('orange')) return `~${(amount / 150).toFixed(1)} medium oranges`;
    if (n.includes('kiwi')) return `~${(amount / 70).toFixed(1)} medium kiwis`;
    if (n.includes('avocado')) return `~${(amount / 150).toFixed(1)} medium avocados`;
    if (n.includes('carrot')) return `~${(amount / 60).toFixed(1)} medium carrots`;
    if (n.includes('tomato')) return `~${(amount / 120).toFixed(1)} medium tomatoes`;
    if (n.includes('bell pepper')) return `~${(amount / 120).toFixed(1)} medium peppers`;
    if (n.includes('cucumber')) return `~${(amount / 300).toFixed(1)} medium cucumbers`;
    if (n.includes('zucchini')) return `~${(amount / 200).toFixed(1)} medium zucchinis`;
    if (n.includes('grapefruit')) return `~${(amount / 250).toFixed(1)} medium grapefruits`;
    if (n.includes('pear')) return `~${(amount / 180).toFixed(1)} medium pears`;
    if (n.includes('peach')) return `~${(amount / 150).toFixed(1)} medium peaches`;
    if (n.includes('plum')) return `~${(amount / 66).toFixed(1)} medium plums`;
    if (n.includes('mango')) return `~${(amount / 200).toFixed(1)} medium mangoes`;

    // Weight conversions
    if (n === 'potato (boiled)') return `~${(amount * 1.15).toFixed(0)}g raw weight`;
    if (n === 'sweet potato (boiled)') return `~${(amount * 1.15).toFixed(0)}g raw weight`;
    if (n === 'broccoli (cooked)') return `~${(amount * 1.1).toFixed(0)}g raw weight`;
    if (n.includes('rice') && n.includes('cooked')) return `~${(amount / 3).toFixed(0)}g dry weight`;
    if (n.includes('pasta') && n.includes('cooked')) return `~${(amount / 2.5).toFixed(0)}g dry weight`;
    if (n.includes('spaghetti') && n.includes('cooked')) return `~${(amount / 2.5).toFixed(0)}g dry weight`;
    if (n.includes('chicken') || n.includes('beef') || n.includes('steak') || n.includes('pork') || n.includes('lamb')) {
        return `~${(amount * 1.35).toFixed(0)}g raw weight`;
    }
    return null;
  };

  const foodSections = ["Proteins", "Carbs", "Fruits", "Fiber and Vegetables", "Nuts", "Dairy", "Fats", "Drink", "Probiotic", "Snacks"];

  return (
    <Container 
        fluid 
        className="vh-100 p-0 animate-up custom-main-container" 
        style={{ background: 'var(--bg-main)' }}
    >
      <style>
        {`
          .custom-main-container {
            overflow-x: hidden;
            overflow-y: auto;
          }
          .panel-left {
          }
          @media (min-width: 992px) {
            .custom-main-container {
              overflow: hidden;
            }
          }
          .tooltip-inner {
            max-width: 95vw !important;
            width: auto !important;
            min-width: 280px !important;
            background-color: rgba(15, 15, 15, 0.95) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5) !important;
            backdrop-filter: blur(8px) !important;
            padding: 0 !important;
          }
          .tooltip.show {
            opacity: 1 !important;
          }
          .best-effort-alert {
            border: 2px solid #ffc107 !important;
            background: rgba(255, 193, 7, 0.05) !important;
          }
          .nutrient-hover-zone {
            cursor: pointer;
            transition: all 0.2s ease;
            padding: 4px;
            margin: -4px;
            border-radius: 8px;
          }
          .nutrient-hover-zone:hover {
            background: rgba(255,255,255,0.05);
          }
        `}
      </style>

      
      
      {runTour && (
      <TourWrapper
          key={runTour ? "form-on" : "form-off"}
          stepIndex={currentStepIndex}
          disableBeacon={true}
          disableOverlayClose={true}
          scrollOffset={150}
          debug={true}
          run={true}
          getHelpers={handleJoyrideHelpers}
          addLog={addLog}
          steps={formSteps}
        continuous={true}
        onEvent={handleJoyrideCallback}
        styles={( {
          options: {
            arrowColor: 'rgba(15, 15, 15, 0.95)',
            backgroundColor: 'rgba(15, 15, 15, 0.95)',
            primaryColor: '#ff3131',
            textColor: '#fff',
            zIndex: 100000,
          },
          tooltip: {
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '16px',
            backdropFilter: 'blur(8px)',
          }
        } as any )}
      />
      )}
      
      {runResultsTour && (
      <TourWrapper
          disableBeacon={true}
          disableOverlayClose={true}
          scrollOffset={150}
          debug={true}
          run={true}
          addLog={addLog}
          steps={resultsSteps}
        continuous={true}
        onEvent={handleResultsJoyrideCallback}
        styles={( {
          options: {
            arrowColor: 'rgba(15, 15, 15, 0.95)',
            backgroundColor: 'rgba(15, 15, 15, 0.95)',
            primaryColor: '#ff3131',
            textColor: '#fff',
            zIndex: 100000,
          },
          tooltip: {
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '16px',
            backdropFilter: 'blur(8px)',
          }
        } as any )}
      />
      )}

      
      {/* DEBUG BOX */}
      <div className="position-fixed bottom-0 start-0 m-3 p-2 bg-dark border border-warning text-warning overflow-hidden" style={{ zIndex: 10000, fontSize: '0.7rem', width: '300px', opacity: 0.9 }}>
        <strong>Joyride Debug:</strong><br/>
        {joyrideLogs.map((l, i) => <div key={i}>{l}</div>)}
      </div>

      {/* START TUTORIAL BUTTON */}
      {!runTour && !runResultsTour && !localStorage.getItem('macros100_tutorial_done') && (
        <Button 
          variant="outline-secondary" 
          size="sm" 
          className="position-fixed top-0 start-0 m-3 glass-panel d-flex align-items-center" style={{ zIndex: 1050 }}
          onClick={() => { addLog("Button clicked"); setRunTour(true); setIsSidebarCollapsed(false); }}
        >
          <Sparkles size={14} className="me-2 text-warning" /> Start Tutorial
        </Button>
      )}

      {/* MOBILE VIEW SWITCHER */}
      {diet && (
        <div className="d-lg-none" style={{ position: 'fixed', top: '15px', right: '15px', zIndex: 1050 }}>
            <Button 
                variant="dark" 
                className="rounded-circle shadow-lg border-2 border-primary p-2"
                onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                style={{ width: '45px', height: '45px' }}
            >
                {isSidebarCollapsed ? <Settings size={20} /> : <ClipboardList size={20} />}
            </Button>
        </div>
      )}

      {/* LIKED FOODS MODAL */}
      <div className={`modal-blur-overlay ${showFoodModal ? 'active' : ''}`} />
      <div className={`custom-modal-container ${showFoodModal ? 'active' : ''}`} onClick={closeFoodModal}>
        <div className="custom-modal-content glass-panel p-4 tour-liked-modal" onClick={e => e.stopPropagation()}>
            <div className="d-flex justify-content-between align-items-center mb-4 tour-liked-foods-modal-header">
                <h2 className="h3 mb-0 fw-bold d-flex align-items-center">
                    <Heart className="me-2 text-liked" size={28} /> Select Liked Foods
                </h2>
                <Button variant="outline-light" className="rounded-circle border-0 modal-close-btn p-0 d-flex align-items-center justify-content-center" style={{ fontSize: '1.5rem', fontWeight: 'bold', width: '50px', height: '50px' }} onClick={closeFoodModal}>
                    ✕
                </Button>
            </div>

            <div className="mb-4 d-flex gap-3 align-items-center search-controls-mobile">
                <Form.Control size="lg" type="text" placeholder="Search ingredients..." className="glass-panel border-0" style={{ background: 'rgba(255,255,255,0.05)', color: 'white' }} value={foodSearch} onChange={(e) => setFoodSearch(e.target.value.toLowerCase())} />
                <div className="d-flex gap-2 btn-group">
                    <Button variant="outline-primary" className="text-nowrap flex-grow-1" onClick={() => setFormData(p => ({ ...p, likedFoods: foods.map(f => f.name) }))}>Select All</Button>
                    <Button variant="outline-danger" className="text-nowrap flex-grow-1" onClick={() => setFormData(p => ({ ...p, likedFoods: [] }))}>Deselect All</Button>
                </div>
            </div>

            <div className="flex-grow-1 overflow-y-auto pr-3 custom-scrollbar">
                {foodSections.map(section => {
                    const sectionFoods = foods.filter(f => f.section === section && f.name.toLowerCase().includes(foodSearch));
                    if (sectionFoods.length === 0) return null;
                    return (
                        <div key={section} className="mb-5">
                            <h5 className="text-uppercase fw-bold text-muted mb-4 pb-2 border-bottom" style={{ fontSize: '0.8rem', letterSpacing: '0.15em' }}>{section}</h5>
                            <Row className="g-3">
                                {sectionFoods.map(food => {
                                    const isSelected = formData.likedFoods.includes(food.name);
                                    return (
                                        <Col xs={6} md={4} lg={3} xl={2} key={food.name}>
                                            <Card className={`food-card ${isSelected ? 'selected' : ''} text-center p-3 h-100`} onClick={() => toggleFood(food.name)}>
                                                {isSelected && <Heart size={16} className="heart-icon position-absolute" style={{ top: '8px', right: '8px' }} />}
                                                <div className="fs-1 mb-2">{food.icon}</div>
                                                <div className="fw-bold" style={{ fontSize: '0.85rem' }}>{food.name}</div>
                                                <div className="d-flex align-items-center justify-content-center mt-2" onClick={(e) => e.stopPropagation()}>
                                                    <span style={{ fontSize: '0.6rem', marginRight: '4px', opacity: 0.6 }}>Max:</span>
                                                    <input type="number" className="food-max-input" style={{ width: '60px', fontSize: '0.7rem' }} value={formData.customMaxAmounts[food.name] || food.maxAmount || ''} onChange={(e) => updateCustomMax(food.name, parseFloat(e.target.value))} />
                                                </div>
                                            </Card>
                                        </Col>
                                    );
                                })}
                            </Row>
                        </div>
                    );
                })}
            </div>
            <div className="mt-4 text-center">
                <Button variant="primary" size="lg" className="px-5" onClick={closeFoodModal}>Save & Close</Button>
            </div>
        </div>
      </div>

      {/* CUSTOM RDAs MODAL */}
      <div className={`modal-blur-overlay ${showRDAModal ? 'active' : ''}`} />
      <div className={`custom-modal-container ${showRDAModal ? 'active' : ''}`} onClick={() => setShowRDAModal(false)}>
        <div className="custom-modal-content glass-panel p-4" onClick={e => e.stopPropagation()} style={{ width: window.innerWidth < 992 ? '95%' : '80%', height: window.innerWidth < 992 ? '95%' : '80%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div className="d-flex justify-content-between align-items-center mb-4 tour-liked-modal-header">
                <h2 className="h3 mb-0 fw-bold d-flex align-items-center">
                    <Activity className="me-2 text-info" size={28} /> Custom RDAs & Upper Limits
                </h2>
                <div className="d-flex align-items-center gap-3">
                    <Button 
                        variant="outline-danger" 
                        size="sm" 
                        className="fw-bold d-flex align-items-center"
                        disabled={Object.keys(formData.customRDAs).length === 0}
                        onClick={() => {
                            if (window.confirm("Are you sure you want to reset ALL nutrients back to standard values?")) {
                                setFormData(prev => ({ ...prev, customRDAs: {} }));
                            }
                        }}
                    >
                        <RotateCcw size={14} className="me-2" /> Reset All to Standard
                    </Button>
                    <Button variant="outline-light" className="rounded-circle border-0 modal-close-btn p-0 d-flex align-items-center justify-content-center" style={{ fontSize: '1.5rem', fontWeight: 'bold' }} onClick={() => setShowRDAModal(false)}>
                        ✕
                    </Button>
                </div>
            </div>

            <div className="flex-grow-1 overflow-y-auto pr-3 custom-scrollbar">
                <Alert variant="info" className="mb-4 bg-opacity-10 border-info text-info">
                    Leave fields empty to use standard gender-specific RDAs.
                </Alert>
                
                {nutrientGroups.map(group => (
                    <div key={group.title} className="mb-5">
                        <h5 className="text-uppercase fw-bold text-muted mb-4 pb-2 border-bottom" style={{ fontSize: '0.8rem', letterSpacing: '0.15em' }}>{group.title}</h5>
                        <Row className="g-4">
                            {group.keys.map(key => (
                                <Col md={6} lg={4} key={key}>
                                    <div className="p-3 rounded-3 border bg-light bg-opacity-5 position-relative">
                                        <div className="d-flex justify-content-between align-items-center mb-2">
                                            <div className="fw-bold text-capitalize" style={{ fontSize: '0.85rem' }}>
                                                {key === 'fatMono' ? 'Monounsaturated Fat' : key === 'fatPoly' ? 'Polyunsaturated Fat' : key === 'fatSat' ? 'Saturated Fat' : key === 'fatTrans' ? 'Trans Fat' : key.replace(/([A-Z])/g, ' $1')}
                                            </div>
                                            <div className="d-flex align-items-center gap-2">
                                                <Form.Check 
                                                    type="switch"
                                                    id={`essential-${key}`}
                                                    label={<small className="text-muted fw-bold" style={{ fontSize: '0.65rem' }}>ESSENTIAL</small>}
                                                    checked={formData.customRDAs[key]?.essential ?? true}
                                                    onChange={(e) => updateCustomRDA(key, 'essential', e.target.checked)}
                                                />
                                                {formData.customRDAs[key] && (
                                                    <Button 
                                                        variant="link" 
                                                        className="p-0 text-muted hover-text-primary" 
                                                        onClick={() => revertNutrient(key)}
                                                        title="Revert to standard"
                                                    >
                                                        <RotateCcw size={14} />
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                        <Row className="g-2">
                                            <Col xs={6}>
                                                <Form.Label className="small text-muted mb-1">Target</Form.Label>
                                                <Form.Control 
                                                    size="sm" 
                                                    type="number" 
                                                    placeholder={getDefaultNutrientConfig(key).target.toString()}
                                                    value={formData.customRDAs[key]?.target ?? ''} 
                                                    onChange={(e) => updateCustomRDA(key, 'target', e.target.value ? parseFloat(e.target.value) : undefined)} 
                                                />
                                            </Col>
                                            <Col xs={6}>
                                                <Form.Label className="small text-muted mb-1">Max Limit</Form.Label>
                                                <Form.Control 
                                                    size="sm" 
                                                    type="number" 
                                                    placeholder={getDefaultNutrientConfig(key).max.toString()}
                                                    value={formData.customRDAs[key]?.max ?? ''} 
                                                    onChange={(e) => updateCustomRDA(key, 'max', e.target.value ? parseFloat(e.target.value) : undefined)} 
                                                />
                                            </Col>
                                        </Row>
                                    </div>
                                </Col>
                            ))}
                        </Row>
                    </div>
                ))}
            </div>
            <div className="mt-4 text-center">
                <Button variant="primary" size="lg" className="px-5" onClick={() => setShowRDAModal(false)}>Save Changes</Button>
            </div>
        </div>
      </div>

      <Row className="h-100 g-0">
        {/* SIDEBAR TOGGLE BUTTON */}
        <div 
            className={`sidebar-toggle-btn ${isSidebarCollapsed ? 'collapsed' : 'expanded'}`}
            onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
            title={isSidebarCollapsed ? "Expand Details" : "Retract Details"}
        >
            {isSidebarCollapsed ? <ChevronRight size={24} /> : <ChevronLeft size={24} />}
        </div>

        {/* LEFT SIDE: DETAILS */}
        <Col lg={5} className={`h-100 overflow-y-auto custom-scrollbar border-end border-secondary border-opacity-10 position-relative panel-left ${isSidebarCollapsed ? 'collapsed' : ''}`}>
          <div className="sidebar-inner-content">
            <div className="p-4 details-content-wrapper mx-auto" style={{ maxWidth: '600px' }}>
              <Card className="border-0 shadow-lg mb-4" style={{ backgroundColor: 'var(--bg-card)' }}>
                <Card.Body className="p-4">
                  <div className="d-flex justify-content-between mb-4 pt-2">
                    <Button variant="outline-primary" size="sm" onClick={copyProfile}>Copy Profile</Button>
                    <Button variant="outline-primary" size="sm" onClick={pasteProfile}>Paste Profile</Button>
                  </div>
                  
                  <h3 className="h5 mb-4 d-flex align-items-center fw-bold">
                    <Calculator className="me-2 text-primary" size={20} /> Your Details
                  </h3>
                  
                  <Form>
                    <div className="tour-biometrics">
                    <Row>
                      <Col md={6} className="mb-3">
                        <Form.Label>Weight (kg)</Form.Label>
                        <Form.Control type="number" step="any" name="weight" value={formData.weight} onChange={handleInputChange} />
                      </Col>
                      <Col md={6} className="mb-3">
                        <Form.Label>Height (cm)</Form.Label>
                        <Form.Control type="number" step="any" name="height" value={formData.height} onChange={handleInputChange} />
                      </Col>
                    </Row>

                    <Row>
                      <Col md={6} className="mb-3">
                        <Form.Label>Age</Form.Label>
                        <Form.Control type="number" step="any" name="age" value={formData.age} onChange={handleInputChange} />
                      </Col>
                      <Col md={6} className="mb-3">
                        <Form.Label>Gender</Form.Label>
                        <Form.Select name="gender" value={formData.gender} onChange={handleInputChange}>
                          <option value="male">Male</option>
                          <option value="female">Female</option>
                        </Form.Select>
                      </Col>
                    </Row>
                    </div>

                    <div className="mb-3 tour-bodyfat">
                      <div className="d-flex justify-content-between align-items-center mb-2">
                        <Form.Label className="mb-0">Body Fat %</Form.Label>
                        <Button 
                          variant="link" 
                          className={`p-0 text-decoration-none fw-bold ${formData.isBfCustom ? 'text-primary' : 'text-muted'}`}
                          style={{ fontSize: '0.65rem', lineHeight: '1' }}
                          onClick={() => setFormData(p => ({ ...p, isBfCustom: !p.isBfCustom }))}
                        >
                          {formData.isBfCustom ? 'LOCK (CUSTOM)' : 'AUTO (ESTIMATED)'}
                        </Button>
                      </div>
                      <Form.Control type="number" step="any" name="bodyFat" value={formData.bodyFat} onChange={handleInputChange} />
                      <Form.Text className="text-muted small" style={{ fontSize: '0.7rem' }}>
                        {!formData.isBfCustom ? "Estimating based on BMI, Age, and Gender" : "Custom value locked. Click AUTO to resume estimation."}
                      </Form.Text>
                    </div>

                    <div className="mb-3 tour-activity">
                      <Form.Label>Activity Level</Form.Label>
                      <Form.Select name="activityLevel" value={formData.activityLevel} onChange={handleInputChange}>
                        <option value="1.2">Sedentary (office job, little exercise)</option>
                        <option value="1.375">Lightly Active (1-3 days exercise/week)</option>
                        <option value="1.55">Moderately Active (3-5 days exercise/week)</option>
                        <option value="1.725">Very Active (6-7 days exercise/week)</option>
                        <option value="1.9">Extra Active (physical job or 2x training)</option>
                      </Form.Select>
                    </div>

                    <div className="mb-3 tour-maintenance">
                      <Form.Label>Maintenance Calories</Form.Label>
                      <Form.Control type="number" name="maintenanceCalories" value={formData.maintenanceCalories} onChange={handleInputChange} />
                    </div>

                    <div className="mb-4 tour-goal">
                      <Form.Label>Goal</Form.Label>
                      <Form.Select name="goal" value={formData.goal} onChange={handleInputChange}>
                        <option value="fast-lose">Fast Lose Weight</option>
                        <option value="moderate-lose">Moderate Lose Weight (Recommended)</option>
                        <option value="maintain">Maintain</option>
                        <option value="moderate-gain">Moderate Gain Weight (Recommended)</option>
                        <option value="fast-gain">Fast Gain Weight</option>
                      </Form.Select>
                    </div>

                    <div className="mb-4 tour-offset">
                      <Form.Label>Calorie Offset</Form.Label>
                      <Form.Control type="number" name="calorieOffset" value={formData.calorieOffset} onChange={handleInputChange} />
                    </div>

                    <div className="mb-4 tour-target">
                      <Form.Label>Target Calories</Form.Label>
                      <Form.Control type="number" name="targetCalories" value={formData.targetCalories} onChange={handleInputChange} />
                    </div>

                    <hr className="my-4" />

                    <h3 className="h5 mb-3 d-flex align-items-center justify-content-between fw-bold tour-macros">
                      <span className="d-flex align-items-center"><Activity className="me-2 text-macro" size={20} /> Macronutrient Split</span>
                      <Form.Check 
                        type="switch"
                        id="custom-macros-switch"
                        label={<small className="text-muted" style={{ fontSize: '0.7rem' }}>Enable Custom</small>}
                        checked={formData.customMacros}
                        onChange={(e) => setFormData(prev => ({ ...prev, customMacros: e.target.checked }))}
                      />
                    </h3>
                    
                    <div style={{ opacity: formData.customMacros ? 1 : 0.5, pointerEvents: formData.customMacros ? 'all' : 'none', transition: 'opacity 0.2s' }}>
                      {(() => {
                        const targetCals = formData.targetCalories || 2000;
                        
                        // Convert current values to percentages for the Pie component
                        const getPct = (m: 'protein'|'fat'|'carbs') => {
                          const macro = formData.macros[m];
                          if (macro.mode === '%') return macro.value / 100;
                          if (macro.mode === 'g/kg') return (macro.value * formData.weight * (m === 'fat' ? 9 : 4)) / targetCals;
                          if (macro.mode === 'g') return (macro.value * (m === 'fat' ? 9 : 4)) / targetCals;
                          return 0.33; // Fallback
                        };

                        const pPct = getPct('protein');
                        const fPct = getPct('fat');

                        return (
                          <>
                            <div className="tour-macros-pie">
                              <InteractiveMacroPie 
                                proteinPct={pPct}
                                fatPct={fPct}
                                targetCalories={targetCals}
                                weight={formData.weight}
                                formData={formData}
                                onChangeStatus={(id, status) => {
                                  handleMacroChange(id, 'strictness', status);
                                }}
                                onChange={(newP, newF) => {
                                  setFormData(prev => ({
                                    ...prev,
                                    macros: {
                                      protein: { ...prev.macros.protein, mode: '%', value: Math.round(newP * 100) },
                                      fat: { ...prev.macros.fat, mode: '%', value: Math.round(newF * 100) },
                                      carbs: { ...prev.macros.carbs, mode: '%', value: Math.round((1 - newP - newF) * 100) }
                                    }
                                  }));
                                }}
                              />
                            </div>
                            
                            <Row className="g-2 mt-4 tour-macros-strictness">
                              {[
                                { id: 'protein', label: 'Protein', color: '#ff3131', pct: pPct, grams: (pPct * targetCals) / 4, cal: pPct * targetCals },
                                { id: 'fat', label: 'Fat', color: '#ffea00', pct: fPct, grams: (fPct * targetCals) / 9, cal: fPct * targetCals },
                                { id: 'carbs', label: 'Carbs', color: '#3d9bff', pct: (1 - pPct - fPct), grams: ((1 - pPct - fPct) * targetCals) / 4, cal: (1 - pPct - fPct) * targetCals }
                              ].map(m => {
                                const divisor = m.id === 'fat' ? 9 : 4;
                                return (
                                <Col key={m.id} xs={12}>
                                  <div className="d-flex justify-content-between align-items-center mb-3">
                                    <div className="d-flex flex-column">
                                      <div className="d-flex align-items-center gap-2">
                                        <span className="fw-bold text-uppercase" style={{ color: m.color }}>{m.label}</span>
                                        <span className="text-white small fw-bold">{Math.round(m.pct * 100)}%</span>
                                      </div>
                                      <div className="text-muted small">
                                        {Math.round(m.grams)}g / {Math.round(m.cal)} kcal / {(m.grams / formData.weight).toFixed(1)} g/kg
                                      </div>
                                    </div>
                                    <Form.Select 
                                      size="sm"
                                      className="w-auto border-0 shadow-none bg-dark text-white fw-bold"
                                      style={{ fontSize: '0.8rem', cursor: 'pointer' }}
                                      value={formData.macros[m.id as 'protein'|'fat'|'carbs'].strictness || 'none'}
                                      onChange={(e) => handleMacroChange(m.id as any, 'strictness', e.target.value)}
                                    >
                                      <option value="none">AUTO</option>
                                      <option value="relaxed">RELAXED</option>
                                      <option value="strict">STRICT</option>
                                    </Form.Select>
                                  </div>
                                </Col>
                                );
                              })}
                            </Row>
                          </>
                        );
                      })()}
                    </div>

                    <hr className="my-4" />

                    <h3 className="h5 mb-3 d-flex align-items-center fw-bold tour-musthave">
                      <Utensils className="me-2 text-musthave" size={20} /> Must Have Foods
                    </h3>
                    <div className="mb-3">
                      <Form.Select size="sm" className="bg-light" onChange={(e) => { if (e.target.value) addMustHave(e.target.value); e.target.value = ""; }}>
                        <option value="">+ Add Must-Have Ingredient</option>
                        {foodSections.map(section => (
                            <optgroup label={section} key={section}>
                                {foods.filter(f => f.section === section).sort((a,b) => a.name.localeCompare(b.name)).map(f => (
                                    <option key={f.name} value={f.name}>{f.icon} {f.name}</option>
                                ))}
                            </optgroup>
                        ))}
                      </Form.Select>
                    </div>
                    <div className="mb-4">
                      {formData.mustHaveFoods.map(must => {
                        const food = foods.find(f => f.name === must.name);
                        return (
                          <div key={must.name} className="d-flex align-items-center mb-2 bg-light p-2 rounded-3 border justify-content-between">
                            <span className="me-2 fs-5">{food?.icon}</span>
                            <div className="flex-grow-1 min-width-0 me-2"><div className="small fw-bold text-truncate">{must.name}</div></div>
                            <div className="d-flex align-items-center gap-1">
                                <Form.Control size="sm" type="number" value={must.min || 0} onChange={(e) => updateMustHaveRange(must.name, 'min', parseFloat(e.target.value))} style={{ width: '85px', fontSize: '0.8rem', padding: '0.2rem' }} className="text-center" />
                                <span className="text-muted small">-</span>
                                <Form.Control size="sm" type="number" value={must.max || 0} onChange={(e) => updateMustHaveRange(must.name, 'max', parseFloat(e.target.value))} style={{ width: '85px', fontSize: '0.8rem', padding: '0.2rem' }} className="text-center" />
                                <span className="small text-muted ms-1">g</span>
                            </div>
                            <Button variant="link" className="p-0 text-danger text-decoration-none ms-2 fw-bold" onClick={() => removeMustHave(must.name)}>X</Button>
                          </div>
                        );
                      })}
                    </div>

                    <hr className="my-4" />

                    <h3 className="h5 mb-3 d-flex align-items-center justify-content-between fw-bold">

                      <span className="d-flex align-items-center tour-advanced"><Activity className="me-2 text-info" size={20} /> Advanced Settings</span>
                      <Form.Check 
                        type="switch"
                        id="advanced-settings-switch"
                        label={<small className="text-muted" style={{ fontSize: '0.7rem' }}>Enable</small>}
                        checked={formData.advancedSettings}
                        onChange={(e) => setFormData(prev => ({ ...prev, advancedSettings: e.target.checked }))}
                      />
                    </h3>

                    {formData.advancedSettings && (
                      <div className="fade-in">
                        <Button 
                          variant="outline-info" 
                          className="w-100 py-2 d-flex align-items-center justify-content-center fw-bold mb-3"
                          onClick={() => setShowRDAModal(true)}
                        >
                          <Utensils className="me-2" size={18} /> Custom RDAs & Upper Limits
                        </Button>
                      </div>
                    )}
                  </Form>
                </Card.Body>
              </Card>
            </div>

            {/* FIXED ACTION BAR */}
            <div className={`bottom-left-actions glass-panel ${isSidebarCollapsed ? 'collapsed' : ''}`}>
              <Button variant="outline-primary" className={`w-100 py-2 d-flex align-items-center justify-content-center fw-bold tour-liked ${shouldWiggle ? 'wiggle' : ''}`} onClick={() => {
                setShowFoodModal(true);
                if (runTour) {
                  setTimeout(() => {
                    setCurrentStepIndex(14);
                  }, 150);
                }
              }}>
                  <Heart className="me-2 text-liked" size={18} /> Select Liked Foods ({formData.likedFoods.length})
              </Button>
              <Button variant="primary" className="w-100 py-3 shadow-sm fw-bold tour-generate" onClick={() => handleSubmit()} disabled={loading}>
                  {loading ? 'Optimizing Parameters...' : 'Generate Daily Plan'}
              </Button>
            </div>
          </div>
        </Col>

        {/* RIGHT SIDE: RESULTS */}
        <Col lg={7} className={`h-100 overflow-y-auto p-5 custom-scrollbar panel-right ${isSidebarCollapsed ? 'expanded' : ''}`}>
          <header className="text-center mb-5 pb-4">
            <div className="d-inline-block px-3 py-1 mb-3 glass-panel rounded-pill small fw-bold text-primary tracking-widest text-uppercase" style={{ fontSize: '0.7rem', border: '1px solid rgba(61, 155, 255, 0.3)' }}>Perfect Nutrition. No Sacrifices.</div>
            <h1 className="display-2 fw-800 mb-3">Macros100</h1>
            <p className="lead text-secondary mx-auto" style={{ maxWidth: '700px', fontSize: '1.1rem' }}>Experience professional-grade mathematical optimization. Your perfect health targets, calculated with scientific accuracy.</p>
          </header>

          {error && (
            <div className="mb-5 fade-in">
                <Alert variant="danger" className="border-0 shadow-lg p-4 d-flex align-items-start glass-panel" style={{ borderLeft: '5px solid #ff3131 !important' }}>
                    <Info size={32} className="me-4 mt-1 text-danger flex-shrink-0" />
                    <div className="flex-grow-1">
                        <h4 className="fw-bold mb-2">Optimization Failed</h4>
                        <p className="mb-3 opacity-75 lead" style={{ fontSize: '1rem' }}>{error}</p>
                        <div className="d-flex gap-2">
                            <Button variant="danger" size="sm" className="fw-bold px-4" onClick={() => setError(null)}>Dismiss & Reconfigure</Button>
                        </div>
                    </div>
                </Alert>
            </div>
          )}
          
          {loading ? (
            <div className="text-center py-5 fade-in">
              <Spinner animation="border" variant="primary" className="mb-4" style={{ width: '3.5rem', height: '3.5rem', borderWidth: '0.25rem' }} />
              <h3 className="h2 fw-bold mb-2">Simulating Biological System</h3>
              <p className="text-muted mb-5">Optimization runtime: <span className="text-primary fw-bold">{progress.time}s</span></p>
              <div className="mx-auto" style={{ maxWidth: '650px' }}>
                <div className="d-flex justify-content-between text-muted small mb-2 fw-bold">
                    <span>OPTIMIZING</span>
                    <span>{Math.round(progress.generation)}%</span>
                </div>
                <ProgressBar animated now={progress.generation} className="shadow-sm" style={{ height: '12px' }} />
              </div>
              <div className="mt-4">
                <Button variant="outline-danger" size="sm" className="px-4 border-0" onClick={cancelGeneration}>Terminate Session</Button>
              </div>
            </div>
          ) : diet ? (
            <div className="fade-in pb-5">
              {diet.error && (
                <Alert variant="warning" className="shadow-lg p-4 d-flex align-items-start glass-panel mb-4 best-effort-alert border-0">
                    <Info size={32} className="me-4 mt-1 text-warning flex-shrink-0" />
                    <div className="flex-grow-1">
                        <h4 className="fw-bold mb-2">Optimization Constraint Notice</h4>
                        <p className="mb-0 opacity-75 lead" style={{ fontSize: '1rem' }}>{diet.error}</p>
                    </div>
                </Alert>
              )}
              <Row className="mb-4 g-4">
                <Col md={4}>
                  <Card className="text-center shadow-sm h-100 p-2 border-0" style={{ background: 'rgba(61, 155, 255, 0.1)', border: '2px solid #3d9bff !important', borderRadius: 'var(--radius-lg)', boxShadow: '0 0 20px rgba(61, 155, 255, 0.2)' }}>
                    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, border: '2px solid #3d9bff', borderRadius: 'var(--radius-lg)', pointerEvents: 'none' }}></div>
                    <Card.Body className="d-flex flex-column justify-content-center">
                      <Target className="mb-3 mx-auto text-primary" size={32} />
                      <div className="text-uppercase small fw-bold tracking-wider opacity-75 mb-1 text-white">Daily Energy</div>
                      <div className="display-6 fw-bold mb-1 text-white">{diet.actualCalories}</div>
                      <div className="small opacity-75 text-white-50">kcal / {diet.targetCalories} target</div>
                    </Card.Body>
                  </Card>
                </Col>
                <Col md={4}>
                  <Card className="text-center shadow-sm h-100 p-2" style={{ background: 'rgba(0, 255, 65, 0.1)', border: '2px solid #00ff41', borderRadius: 'var(--radius-lg)', boxShadow: '0 0 20px rgba(0, 255, 65, 0.2)' }}>
                    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, border: '2px solid #00ff41', borderRadius: 'var(--radius-lg)', pointerEvents: 'none' }}></div>
                    <Card.Body className="d-flex flex-column justify-content-center">
                      <Activity className="mb-3 mx-auto text-success" size={32} />
                      <div className="text-uppercase small fw-bold tracking-wider opacity-75 mb-1 text-white">Nutrient Score</div>
                      <div className="display-6 fw-bold mb-1 text-white">{diet.accuracy}%</div>
                      <div className="small opacity-75 text-white-50">Biological Saturation</div>
                    </Card.Body>
                  </Card>
                </Col>
                <Col md={4}>
                  <Card className="shadow-sm border-0 h-100 p-3 glass-panel">
                    <Card.Body className="d-flex align-items-center p-0">
                      {(() => {
                        const pCal = diet.macros.protein * 4;
                        const cCal = diet.macros.carbs * 4;
                        const fCal = diet.macros.fat * 9;
                        const totalCal = pCal + cCal + fCal || 1;
                        
                        const pPct = pCal / totalCal;
                        const cPct = cCal / totalCal;
                        const fPct = fCal / totalCal;

                        // Calculate SVG path for pie slices
                        let cumulativePct = 0;
                        const getCoordinatesForPercent = (percent: number) => {
                          const x = Math.cos(2 * Math.PI * percent);
                          const y = Math.sin(2 * Math.PI * percent);
                          return [x, y];
                        };

                        const createPath = (percent: number, color: string) => {
                          if (percent >= 1) return <circle cx="0" cy="0" r="1" fill={color} />;
                          if (percent <= 0) return null;
                          const [startX, startY] = getCoordinatesForPercent(cumulativePct);
                          cumulativePct += percent;
                          const [endX, endY] = getCoordinatesForPercent(cumulativePct);
                          const largeArcFlag = percent > 0.5 ? 1 : 0;
                          const pathData = [
                            `M ${startX} ${startY}`,
                            `A 1 1 0 ${largeArcFlag} 1 ${endX} ${endY}`,
                            `L 0 0`,
                          ].join(' ');
                          return <path d={pathData} fill={color} />;
                        };

                        return (
                          <Row className="w-100 g-0 align-items-center">
                            <Col xs={5} className="d-flex flex-column gap-3 border-end border-secondary border-opacity-10 py-1">
                              <div className="ps-1">
                                <div className="small fw-bold text-white-50 text-uppercase tracking-wider mb-1" style={{ fontSize: '0.6rem' }}>Protein</div>
                                <div className="h5 mb-0 fw-bold" style={{ color: 'var(--accent-danger)' }}>{diet.macros.protein}g</div>
                              </div>
                              <div className="ps-1">
                                <div className="small fw-bold text-white-50 text-uppercase tracking-wider mb-1" style={{ fontSize: '0.6rem' }}>Carbs</div>
                                <div className="h5 mb-0 fw-bold text-primary">{diet.macros.carbs}g</div>
                              </div>
                              <div className="ps-1">
                                <div className="small fw-bold text-white-50 text-uppercase tracking-wider mb-1" style={{ fontSize: '0.6rem' }}>Fat</div>
                                <div className="h5 mb-0 fw-bold" style={{ color: 'var(--accent-warn)' }}>{diet.macros.fat}g</div>
                              </div>
                            </Col>
                            <Col xs={7} className="d-flex justify-content-center align-items-center p-2">
                              <div style={{ width: '100px', height: '100px', filter: 'drop-shadow(0 0 8px rgba(0,0,0,0.5))' }}>
                                <svg viewBox="-1 -1 2 2" style={{ transform: 'rotate(-90deg)', width: '100%', height: '100%' }}>
                                  {createPath(pPct, '#ff3131')}
                                  {createPath(cPct, '#3d9bff')}
                                  {createPath(fPct, '#ffea00')}
                                </svg>
                              </div>
                            </Col>
                          </Row>
                        );
                      })()}
                    </Card.Body>
                  </Card>
                </Col>
              </Row>

              <Accordion defaultActiveKey="0" className="mt-4 mb-4 custom-accordion" data-bs-theme="dark">
                <Accordion.Item eventKey="0" className="tour-result-1 glass-panel border-0 mb-3 overflow-hidden">
                  <Accordion.Header>
                    <h3 className="h5 fw-bold mb-0 d-flex align-items-center m-0"><Utensils className="me-2 text-primary-vibrant" size={20} /> Daily Ingredient List</h3>
                  </Accordion.Header>
                  <Accordion.Body className="p-4 pt-3">
                    <div className="d-flex align-items-center justify-content-end mb-4 gap-2">
                      <div className="d-none d-lg-flex gap-2">
                    <Button variant="outline-info" size="sm" className="fw-bold px-3" onClick={() => {
                      let report = `DIET ANALYSIS REPORT\n`;
                      report += `Target Calories: ${diet.targetCalories} kcal\n`;
                      report += `Actual Calories: ${diet.actualCalories} kcal\n`;
                      report += `Accuracy Score: ${diet.accuracy}%\n\n`;
                      report += `MACROS:\n`;
                      report += `Protein: ${diet.macros.protein}g\n`;
                      report += `Carbs: ${diet.macros.carbs}g\n`;
                      report += `Fat: ${diet.macros.fat}g\n\n`;
                      report += `NUTRIENT BREAKDOWN:\n`;
                      
                      Object.entries(diet.micronutrients).forEach(([key, data]) => {
                        const name = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
                        report += `${name}: ${data.amount.toFixed(1)}${data.unit} (${Math.round(data.total)}% of target)\n`;
                      });
                      
                      navigator.clipboard.writeText(report);
                      alert('Detailed analysis copied to clipboard!');
                    }}>Export Analysis</Button>
                    <Button variant="outline-primary" size="sm" className="fw-bold px-3" onClick={() => { const text = Object.values(diet.sectionedIngredients).flat().map(i => `${i.amount}g ${i.name}`).join('\n'); navigator.clipboard.writeText(text); alert('Copied to clipboard!'); }}>Export for Cronometer</Button>
                  </div>
                  <div className="d-flex gap-2">
                    {isEditing && (
                        <Button variant="outline-danger" size="sm" className="fw-bold px-3 d-flex align-items-center" onClick={revertToOriginal}>
                            <RotateCcw size={14} className="me-2" /> Revert to Original
                        </Button>
                    )}
                    <Button variant={isEditing ? "success" : "outline-primary"} size="sm" className="fw-bold px-3" onClick={() => setIsEditing(!isEditing)}>{isEditing ? 'Save Edits' : 'Edit Diet'}</Button>
                  </div>
                </div>
              
              <div className="mb-5">
                {diet.sectionedIngredients && Object.entries(diet.sectionedIngredients).map(([section, items]) => (
                  <div key={section} className="mb-5">
                    <h5 className="text-uppercase fw-bold text-muted mb-4 pb-2 border-bottom d-flex justify-content-between align-items-center" style={{ fontSize: '0.75rem', letterSpacing: '0.1em' }}>
                        {section}
                    </h5>
                    <Row className="g-3">
                      {items?.map((ing, idx) => (
                        <Col md={6} lg={4} key={idx}>
                          <Card className="shadow-sm h-100 border-0 hover-lift glass-panel position-relative" style={{ overflow: 'visible' }}>
                            {isEditing && (
                                <Button 
                                    variant="danger" 
                                    size="sm" 
                                    className="position-absolute p-0 d-flex align-items-center justify-content-center fw-bold shadow-sm" 
                                    style={{ top: '0', right: '0', transform: 'translate(25%, -25%)', width: '16px', height: '16px', zIndex: 100, fontSize: '0.5rem', border: '2px solid var(--bg-card)', borderRadius: '50%' }}
                                    onClick={() => removeIngredient(section, idx)}
                                >
                                    ✕
                                </Button>
                            )}
                            <Card.Body className="d-flex align-items-center p-3">
                              <div className="rounded-circle p-3 me-3 fs-3 d-flex align-items-center justify-content-center" style={{ width: '64px', height: '64px', background: 'rgba(255,255,255,0.05)' }}>{ing.icon}</div>
                              <div className="min-width-0">
                                <div className="fw-bold text-white mb-1" style={{ fontSize: '0.9rem', lineHeight: '1.2' }}>{ing.name}</div>
                                {isEditing ? (
                                    <div className="d-flex align-items-center gap-1">
                                        <Form.Control 
                                            size="sm" 
                                            type="number" 
                                            className="bg-transparent border-primary text-white fw-bold h4 mb-0" 
                                            style={{ width: '100px', border: 'none', borderBottom: '2px solid var(--accent-primary)', borderRadius: 0, padding: 0 }}
                                            value={ing.amount} 
                                            onChange={(e) => handleAmountChange(section, idx, e.target.value)} 
                                        />
                                        <small className="fs-6 fw-normal text-muted">g</small>
                                        {originalDiet?.sectionedIngredients[section]?.[idx] && originalDiet.sectionedIngredients[section][idx].amount !== ing.amount && (
                                            <Button 
                                                variant="link" 
                                                className="p-0 text-muted hover-text-primary ms-2" 
                                                onClick={() => revertFood(section, idx)}
                                                title="Revert to original"
                                            >
                                                <RotateCcw size={14} />
                                            </Button>
                                        )}
                                    </div>
                                ) : (
                                    <div className="h4 mb-0 fw-bold text-primary">{ing.amount}<small className="fs-6 fw-normal text-muted ms-1">g</small></div>
                                )}
                                {getConversion(ing.name, ing.amount) && (
                                    <div className="text-success-vibrant fw-bold mt-1" style={{ fontSize: '0.7rem' }}>
                                        {getConversion(ing.name, ing.amount)}
                                    </div>
                                )}
                                <div className="text-muted small mt-1" style={{ fontSize: '0.7rem' }}>{ing.calories} calories</div>
                              </div>
                            </Card.Body>
                          </Card>
                        </Col>
                      ))}
                      {isEditing && (
                        <Col md={6} lg={4}>
                          <Card 
                            className="shadow-sm h-100 border-0 glass-panel d-flex align-items-center justify-content-center border-dashed border-2" 
                            style={{ minHeight: '100px', cursor: 'pointer', borderColor: 'rgba(255,255,255,0.1) !important' }}
                            onClick={() => setShowAddIngredientModal({ section })}
                          >
                            <div className="text-muted d-flex flex-column align-items-center">
                                <div className="fs-2 mb-1">+</div>
                                <div className="small fw-bold">Add to {section}</div>
                            </div>
                          </Card>
                        </Col>
                      )}
                    </Row>
                  </div>
                ))}
              </div>

              {/* ADD INGREDIENT MODAL */}
              <div className={`modal-blur-overlay ${showAddIngredientModal ? 'active' : ''}`} />
              <div className={`custom-modal-container ${showAddIngredientModal ? 'active' : ''}`} onClick={() => setShowAddIngredientModal(null)}>
                <div className="custom-modal-content glass-panel p-4" onClick={e => e.stopPropagation()} style={{ width: window.innerWidth < 992 ? '95%' : '60%', maxHeight: '85%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <div className="d-flex justify-content-between align-items-center mb-4 tour-liked-modal-header">
                        <h2 className="h4 mb-0 fw-bold">Add Ingredient to {showAddIngredientModal?.section}</h2>
                        <Button variant="outline-light" className="rounded-circle border-0" onClick={() => setShowAddIngredientModal(null)}>✕</Button>
                    </div>
                    <div className="flex-grow-1 overflow-y-auto pr-3 custom-scrollbar">
                        <Row className="g-3">
                            {foods
                                .filter(f => f.section === showAddIngredientModal?.section)
                                .sort((a,b) => a.name.localeCompare(b.name))
                                .map(f => (
                                <Col xs={12} key={f.name}>
                                    <div className="p-3 rounded-3 border bg-light bg-opacity-5 d-flex align-items-center justify-content-between hover-lift">
                                        <div className="d-flex align-items-center">
                                            <span className="fs-4 me-3">{f.icon}</span>
                                            <div>
                                                <div className="fw-bold">{f.name}</div>
                                                <div className="small text-muted">{f.calories} kcal / 100g</div>
                                            </div>
                                        </div>
                                        <div className="d-flex align-items-center gap-2">
                                            <Form.Control 
                                                size="sm" 
                                                type="number" 
                                                placeholder="Amount (g)" 
                                                id={`add-amt-${f.name}`} 
                                                style={{ width: '100px' }}
                                                defaultValue={100}
                                            />
                                            <Button 
                                                variant="primary" 
                                                size="sm" 
                                                onClick={() => {
                                                    const amt = parseFloat((document.getElementById(`add-amt-${f.name}`) as HTMLInputElement).value) || 100;
                                                    addIngredient(showAddIngredientModal!.section, f.name, amt);
                                                }}
                                            >Add</Button>
                                        </div>
                                    </div>
                                </Col>
                            ))}
                        </Row>
                    </div>
                </div>
              </div>
                  </Accordion.Body>
                </Accordion.Item>

                <Accordion.Item eventKey="1" className="tour-result-2 glass-panel border-0 mb-3 overflow-hidden">
                  <Accordion.Header>
                    <h3 className="h5 fw-bold mb-0 d-flex align-items-center m-0">
                      <Sparkles className="me-2 text-warning-vibrant" size={20} /> Full Day Meal Plan
                    </h3>
                  </Accordion.Header>
                  <Accordion.Body className="p-4 pt-3">
                    {!mealPlan && !mealPlanLoading && (
                      <div className="text-center py-5">
                        <Sparkles size={48} className="text-warning-vibrant mb-3 opacity-50" />
                        <h4 className="fw-bold">Automate Your Meals</h4>
                        <p className="text-secondary mb-4 mx-auto" style={{ maxWidth: '500px' }}>
                          Let our AI chef instantly organize these precise ingredients into delicious, logical meals. It strictly follows your macros and won't add any unauthorized foods.
                        </p>
                        
                        <div className="mx-auto text-start mb-4" style={{ maxWidth: '500px' }}>
                          <Form.Group>
                            <Form.Label className="text-muted small fw-bold">Custom Instructions (Optional)</Form.Label>
                            <Form.Control 
                              as="textarea" 
                              rows={3} 
                              placeholder="e.g., I prefer a big breakfast, make sure the salmon is for dinner, I don't like eating before noon..."
                              className="bg-dark text-light border-secondary border-opacity-25 custom-scrollbar"
                              value={customInstructions}
                              onChange={(e) => setCustomInstructions(e.target.value)}
                              style={{ resize: 'none' }}
                            />
                          </Form.Group>
                        </div>

                        <Button 
                          variant="primary" 
                          className="rounded-pill d-inline-flex align-items-center fw-bold px-4 py-2"
                          onClick={handleGenerateMealPlan}
                        >
                          <Sparkles size={18} className="me-2" />
                          Generate AI Meal Plan
                        </Button>
                        {mealPlanError && <Alert variant="danger" className="mt-3 text-start mx-auto" style={{ maxWidth: '500px' }}>{mealPlanError}</Alert>}
                      </div>
                    )}

                    {mealPlanLoading && (
                      <div className="text-center py-5">
                        <Spinner animation="border" variant="warning" className="mb-3" />
                        <h5 className="fw-bold">Generating your perfect day...</h5>
                        <p className="text-secondary small">This usually takes about 5 seconds.</p>
                      </div>
                    )}

                    {mealPlan && (
                      <div>
                        <div className="d-flex justify-content-between align-items-center mb-4 border-bottom border-secondary border-opacity-25 pb-3">
                          <h4 className="fw-bold m-0 text-warning-vibrant">Your Custom Meal Plan</h4>
                          <Button variant="outline-light" size="sm" onClick={() => { navigator.clipboard.writeText(mealPlan); alert('Meal plan copied!'); }}>
                            <ClipboardList size={16} className="me-2" /> Copy Plan
                          </Button>
                        </div>
                        <div className="p-4 rounded text-light" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.05)' }}>
                          <ReactMarkdown>
                            {mealPlan}
                          </ReactMarkdown>
                          <div className="mt-4 text-center">
                            <Button variant="outline-secondary" size="sm" onClick={() => setMealPlan(null)}>
                              <RotateCcw size={14} className="me-2" /> Start Over / Edit Prompt
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </Accordion.Body>
                </Accordion.Item>

                <Accordion.Item eventKey="2" className="tour-result-3 glass-panel border-0 mb-3 overflow-hidden">
                  <Accordion.Header>
                    <h3 className="h5 fw-bold mb-0 d-flex align-items-center m-0">
                      <Activity className="me-2 text-success-vibrant" size={20} /> Nutritional Breakdown
                    </h3>
                  </Accordion.Header>
                  <Accordion.Body className="p-4 pt-3">
                    
                    {[ 
                      { title: "General", keys: ["energy", "water", "caffeine", "alcohol"] },
                      { title: "Carbohydrates", keys: ["carbs", "net_carbs", "fiber", "sugars"] },
                      { title: "Lipids", keys: ["fat", "cholesterol", "fatMono", "fatPoly", "omega3", "omega6", "fatSat", "fatTrans"] },
                      { title: "Protein (Amino Acids)", keys: ["protein", "cystine", "histidine", "isoleucine", "leucine", "lysine", "methionine", "phenylalanine", "threonine", "tryptophan", "tyrosine", "valine", "arginine", "glutamine", "glycine", "proline"] },
                      { title: "Vitamins", keys: ["b1", "b2", "b3", "b5", "b6", "b12", "folate", "a", "c", "d", "e", "k", "biotin", "choline"] },
                      { title: "Minerals", keys: ["calcium", "copper", "iron", "magnesium", "manganese", "phosphorus", "potassium", "selenium", "sodium", "zinc", "iodine", "fluoride", "boron", "chromium", "molybdenum", "chloride"] },
                      { title: "Phytonutrients & Other", keys: ["betaine", "lutein_zeaxanthin", "lycopene", "quercetin", "anthocyanins"] }
                    ].map(group => {
                      const visibleKeys = group.keys.filter(k => diet.micronutrients[k]);
                      if (visibleKeys.length === 0) return null;
                      
                      return (
                        <div key={group.title} className="mb-5">
                          <h5 className="text-primary-vibrant border-bottom border-secondary border-opacity-25 pb-2 mb-4 fw-bold small text-uppercase tracking-wider">{group.title}</h5>
                          <Row className="g-4">
                            {visibleKeys.map(name => {
                              const data = diet.micronutrients[name];
                              if (!data) return null;
                              const pct = Math.round(data.total || 0);
                              const isOverMax = data.max && data.amount > (data.max + 0.1);
                              
                              let statusClass = 'text-danger-vibrant';
                              let variant = 'danger';
                              
                              const isOptimal = data.optimalMin && data.optimalMax && data.amount >= (data.optimalMin * 0.85) && data.amount <= (data.optimalMax * 1.15);
                              
                              if (isOverMax) {
                                statusClass = ''; // Clear classes to use inline style
                                variant = 'warning';
                              } else if (isOptimal) {
                                statusClass = 'text-primary-vibrant';
                                variant = 'primary';
                              } else if (pct >= 95) {
                                statusClass = 'text-success-vibrant';
                                variant = 'success';
                              } else if (pct >= 70) {
                                statusClass = 'text-warning-vibrant';
                                variant = 'warning';
                              }

                              const topFoods = [...foods]
                                .map(f => {
                                  let val = 0;
                                  if (name === 'energy') val = f.calories;
                                  else if (name === 'protein') val = f.protein;
                                  else if (name === 'carbs') val = f.carbs;
                                  else if (name === 'fat') val = f.fat;
                                  else if (name === 'net_carbs') val = Math.max(0, f.carbs - (f.nutrients?.fiber || 0));
                                  else val = f.nutrients?.[name] || 0;
                                  return { name: f.name, value: val };
                                })
                                .filter(f => f.value > 0)
                                .sort((a, b) => b.value - a.value)
                                .slice(0, 10);

                              return (
                                <Col md={6} xl={4} key={name}>
                                  <OverlayTrigger
                                    placement="top"
                                    trigger={['hover', 'focus']}
                                    delay={{ show: 100, hide: 0 }}
                                    overlay={
                                      <Tooltip id={`tooltip-${name}`} style={{ pointerEvents: 'none', maxWidth: '400px' }}>
                                        <div className="p-3" style={{ textAlign: 'left', width: '320px' }}>
                                          <div className="fw-bold border-bottom border-secondary border-opacity-25 pb-2 mb-3 text-uppercase" style={{ fontSize: '0.9rem', letterSpacing: '0.05em', color: '#3d9bff' }}>
                                            {name === 'fatMono' ? 'Monounsaturated Fat' : name === 'fatPoly' ? 'Polyunsaturated Fat' : name === 'fatSat' ? 'Saturated Fat' : name === 'fatTrans' ? 'Trans Fat' : name === 'energy' ? 'Energy' : name.replace(/([A-Z])/g, ' $1')}
                                          </div>
                                          
                                          <div className="text-info small fw-bold mb-2 text-uppercase tracking-wider" style={{ fontSize: '0.75rem' }}>Current Diet Contributors</div>
                                          {data.sources && data.sources.length > 0 ? (
                                            <div className="d-flex flex-column gap-2 mb-3">
                                              {data.sources.slice(0, 10).map((src, i) => (
                                                <div key={i} className="d-flex justify-content-between align-items-center gap-4">
                                                  <span className="text-white small fw-medium text-truncate" style={{ maxWidth: '180px', fontSize: '0.85rem' }}>{src.food}</span>
                                                  <span className="fw-bold" style={{ whiteSpace: 'nowrap', fontSize: '0.85rem' }}>
                                                    {src.amount}{data.unit} <span className="text-info ms-1" style={{ fontSize: '0.75rem' }}>({src.pctOfTotal}%)</span>
                                                  </span>
                                                </div>
                                              ))}
                                              {data.sources.length > 10 && <div className="text-center text-muted small mt-2">+{data.sources.length - 10} more ingredients</div>}
                                            </div>
                                          ) : (
                                            <div className="text-muted small italic mb-3">No specific sources identified.</div>
                                          )}

                                          {topFoods.length > 0 && (
                                            <div className="pt-3 border-top border-secondary border-opacity-25">
                                              <div className="text-primary-vibrant small fw-bold mb-2 text-uppercase tracking-wider" style={{ fontSize: '0.75rem' }}>Top 10 Sources (Highest Concentration)</div>
                                              <div className="small text-white opacity-75" style={{ lineHeight: '1.5', fontSize: '0.8rem' }}>
                                                {topFoods.map((f, i) => (
                                                  <span key={i}>
                                                    {f.name}{i < topFoods.length - 1 ? ', ' : ''}
                                                  </span>
                                                ))}
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      </Tooltip>
                                    }
                                  >
                                    <div className="nutrient-hover-zone">
                                      <div className="mb-1 d-flex justify-content-between align-items-center">
                                        <span className="text-uppercase fw-bold text-white opacity-75" style={{ fontSize: '0.65rem', letterSpacing: '0.05em' }}>
                                          {name === 'fatMono' ? 'Monounsaturated Fat' : name === 'fatPoly' ? 'Polyunsaturated Fat' : name === 'fatSat' ? 'Saturated Fat' : name === 'fatTrans' ? 'Trans Fat' : name === 'energy' ? 'Energy' : name.replace(/([A-Z])/g, ' $1')} 
                                        </span>
                                        <span className={`small fw-bold ${statusClass}`} style={isOverMax ? { color: '#ff8c00' } : {}}>
                                          {(data.amount || 0).toFixed(1)} {data.unit} ({pct}%)
                                        </span>
                                      </div>
                                      <div className="nutrient-progress-wrapper" style={{ position: 'relative' }}>
                                        <ProgressBar 
                                          now={pct} 
                                          variant={isOverMax ? undefined : variant} 
                                          className="nutrient-progress"
                                          style={isOverMax ? { backgroundColor: 'rgba(255, 140, 0, 0.2)' } : {}}
                                        />
                                        {isOverMax && (
                                          <div 
                                            className="progress-bar" 
                                            style={{ 
                                              width: `${Math.min(pct, 100)}%`, 
                                              backgroundColor: '#ff8c00',
                                              position: 'absolute',
                                              top: 0,
                                              left: 0,
                                              height: '100%',
                                              borderRadius: '4px',
                                              transition: 'width 0.6s ease'
                                            }} 
                                          />
                                        )}
                                      </div>
                                    </div>
                                  </OverlayTrigger>
                                </Col>
                              );
                            })}
                          </Row>
                        </div>
                      );
                    })}
                    <Alert variant="info" className="mt-4 py-3 border-0 glass-panel shadow-sm">
                      <div className="d-flex">
                        <Info size={20} className="me-3 text-info flex-shrink-0" />
                        <div className="small text-secondary"><strong>Optimization Logic:</strong> The algorithm prioritizes nutrient density to achieve 100% of all physiological targets while strictly adhering to your calorie and macro-nutrient constraints.</div>
                      </div>
                    </Alert>
                  </Accordion.Body>
                </Accordion.Item>
              </Accordion>
            </div>
          ) : (
            <div className="text-center py-5 mt-5">
              <Calculator size={64} className="text-primary opacity-25 mb-4" />
              <h2 className="h3 fw-bold mb-3">Awaiting Configuration</h2>
              <p className="text-secondary mx-auto" style={{ maxWidth: '450px' }}>Complete your biometric data and dietary preferences in the sidebar to generate a mathematically perfect meal plan.</p>
            </div>
          )}
        </Col>
      </Row>

    </Container>
  );
};

export default DietPlanner;
