/* ============================================================
   EXERCISE DATABASE
   met = metabolic equivalent, used for calorie estimation
   type: 'strength' (sets x reps x weight) | 'cardio' (duration based) | 'bodyweight'
   ============================================================ */
const EXERCISE_DB = [
  // ---- CHEST ----
  {"id":"bench-press-barbell","name":"Barbell Bench Press","muscle":"chest","icon":"🏋️","type":"strength","met":5.0,"videoUrl":"https://www.youtube.com/watch?v=gRVjAtPip0Y","bodyMap":["chest","triceps","shoulders"]},
  {"id":"bench-press-dumbbell","name":"Dumbbell Bench Press","muscle":"chest","icon":"🏋️","type":"strength","met":5.0,"bodyMap":["chest","triceps","shoulders"],"videoUrl":"https://www.youtube.com/watch?v=J-gWN5hYwRU"},
  {"id":"incline-bench-press","name":"Incline Bench Press","muscle":"chest","icon":"🏋️","type":"strength","met":5.0,"bodyMap":["chest","shoulders","triceps"],"videoUrl":"https://www.youtube.com/watch?v=SrqOu55lrYU"},
  {"id":"incline-bench-press-dumbbell","name":"Incline Dumbbell Press","muscle":"chest","icon":"🏋️","type":"strength","met":5.0,"bodyMap":["chest","shoulders","triceps"],"videoUrl":"https://www.youtube.com/watch?v=hChjZQhX1Ls"},
  {"id":"decline-bench-press","name":"Decline Bench Press","muscle":"chest","icon":"🏋️","type":"strength","met":5.0,"videoUrl":"https://www.youtube.com/watch?v=8iPEnn-ltC8","bodyMap":["chest","triceps"]},
  {"id":"chest-fly-dumbbell","name":"Dumbbell Chest Fly","muscle":"chest","icon":"🏋️","type":"strength","met":4.5,"videoUrl":"https://www.youtube.com/watch?v=98aRvyw-IGg","bodyMap":["chest"]},
  {"id":"cable-crossover","name":"Cable Crossover","muscle":"chest","icon":"🏋️","type":"strength","met":4.5,"videoUrl":"https://www.youtube.com/watch?v=OfSpPLXaEDk","bodyMap":["chest"]},
  {"id":"push-up","name":"Push-Up","muscle":"chest","icon":"💪","type":"bodyweight","met":3.8,"bodyMap":["chest","triceps","shoulders"],"videoUrl":"https://www.youtube.com/watch?v=WDIpL0pjun0"},
  {"id":"dips-chest","name":"Chest Dips","muscle":"chest","icon":"💪","type":"bodyweight","met":5.5,"bodyMap":["chest","triceps"],"videoUrl":"https://www.youtube.com/watch?v=yN6Q1UI_xkE"},
  {"id":"dips-assisted","name":"Assisted Dips","muscle":"chest","icon":"💪","type":"strength","met":4.5,"assisted":true,"videoUrl":"https://www.youtube.com/watch?v=P9CkuhCc0TE","bodyMap":["chest","triceps"]},
  {"id":"pec-deck","name":"Pec Deck Machine","muscle":"chest","icon":"🏋️","type":"strength","met":4.0,"bodyMap":["chest"],"videoUrl":"https://www.youtube.com/watch?v=ybi3NPUK47M"},
  {"id":"chest-press-machine","name":"Chest Press Machine","muscle":"chest","icon":"🏋️","type":"strength","met":4.5,"videoUrl":"https://www.youtube.com/watch?v=pLofEAcfsO8","bodyMap":["chest","triceps","shoulders"]},

  // ---- BACK ----
  {"id":"deadlift","name":"Deadlift","muscle":"back","icon":"🏋️","type":"strength","met":6.0,"videoUrl":"https://www.youtube.com/watch?v=p2OPUi4xGrM","bodyMap":["lower_back","glutes","hamstrings","lats","upper_back"]},
  {"id":"pull-up","name":"Pull-Up","muscle":"back","icon":"💪","type":"bodyweight","met":8.0,"bodyMap":["lats","biceps"],"videoUrl":"https://www.youtube.com/watch?v=TMnxKjdYcME"},
  {"id":"chin-up","name":"Chin-Up","muscle":"back","icon":"💪","type":"bodyweight","met":8.0,"bodyMap":["lats","biceps"],"videoUrl":"https://www.youtube.com/watch?v=liebDvbcdow"},
  {"id":"pull-up-assisted","name":"Assisted Pull-Up","muscle":"back","icon":"💪","type":"strength","met":5.5,"assisted":true,"videoUrl":"https://www.youtube.com/watch?v=wFj808u2HWU","bodyMap":["lats","biceps"]},
  {"id":"lat-pulldown","name":"Lat Pulldown","muscle":"back","icon":"🏋️","type":"strength","met":5.0,"videoUrl":"https://www.youtube.com/watch?v=Z_3xHwuO8Tk","bodyMap":["lats","biceps"]},
  {"id":"barbell-row","name":"Barbell Row","muscle":"back","icon":"🏋️","type":"strength","met":5.5,"videoUrl":"https://www.youtube.com/watch?v=ML1L5ytxLMY","bodyMap":["lats","upper_back","biceps"]},
  {"id":"dumbbell-row","name":"Single-Arm Dumbbell Row","muscle":"back","icon":"🏋️","type":"strength","met":5.5,"bodyMap":["lats","upper_back","biceps"],"videoUrl":"https://www.youtube.com/results?search_query=single+arm+dumbbell+row+proper+form"},
  {"id":"seated-cable-row","name":"Seated Cable Row","muscle":"back","icon":"🏋️","type":"strength","met":5.0,"videoUrl":"https://www.youtube.com/watch?v=f_r95UajQcg","bodyMap":["upper_back","lats","biceps"]},
  {"id":"mid-row","name":"Mid Row","muscle":"back","icon":"🏋️","type":"strength","met":5.0,"bodyMap":["upper_back","lats"],"videoUrl":"https://www.youtube.com/results?search_query=mid+row+machine+proper+form"},
  {"id":"t-bar-row","name":"T-Bar Row","muscle":"back","icon":"🏋️","type":"strength","met":5.5,"bodyMap":["upper_back","lats","biceps"],"videoUrl":"https://www.youtube.com/watch?v=TyLoy3n_a10"},
  {"id":"face-pull","name":"Face Pull","muscle":"back","icon":"🏋️","type":"strength","met":3.5,"bodyMap":["upper_back","shoulders"],"videoUrl":"https://www.youtube.com/watch?v=eTCBSFlCJ_s"},
  {"id":"hyperextension","name":"Back Extension","muscle":"back","icon":"💪","type":"bodyweight","met":4.0,"bodyMap":["lower_back","glutes"],"videoUrl":"https://www.youtube.com/watch?v=ph3pddpKzzw"},
  {"id":"good-morning","name":"Good Morning","muscle":"back","icon":"🏋️","type":"strength","met":5.0,"bodyMap":["lower_back","hamstrings","glutes"],"videoUrl":"https://www.youtube.com/watch?v=YA-h3n9L4YU"},
  {"id":"shrugs","name":"Barbell Shrugs","muscle":"back","icon":"🏋️","type":"strength","met":3.5,"videoUrl":"https://www.youtube.com/watch?v=NAqCVe2mwzM","bodyMap":["upper_back"]},

  // ---- LEGS ----
  {"id":"squat-barbell","name":"Barbell Back Squat","muscle":"legs","icon":"🦵","type":"strength","met":6.0,"videoUrl":"https://www.youtube.com/watch?v=8PMjqgR8Wa8","bodyMap":["quads","glutes","hamstrings"]},
  {"id":"front-squat","name":"Front Squat","muscle":"legs","icon":"🦵","type":"strength","met":6.0,"bodyMap":["quads","glutes"],"videoUrl":"https://www.youtube.com/results?search_query=front+squat+proper+form"},
  {"id":"leg-press","name":"Leg Press","muscle":"legs","icon":"🦵","type":"strength","met":5.0,"videoUrl":"https://www.youtube.com/watch?v=ETOAyWM6i6A","bodyMap":["quads","glutes","hamstrings"]},
  {"id":"lunges","name":"Walking Lunges","muscle":"legs","icon":"🦵","type":"bodyweight","met":5.0,"bodyMap":["quads","glutes","hamstrings"],"videoUrl":"https://www.youtube.com/watch?v=QSl2G4Mn53Q"},
  {"id":"dumbbell-lunge","name":"Dumbbell Lunge","muscle":"legs","icon":"🦵","type":"strength","met":5.5,"bodyMap":["quads","glutes","hamstrings"],"videoUrl":"https://www.youtube.com/watch?v=_DLIS8SySzs"},
  {"id":"bulgarian-split-squat","name":"Bulgarian Split Squat","muscle":"legs","icon":"🦵","type":"strength","met":5.5,"bodyMap":["quads","glutes","hamstrings"],"videoUrl":"https://www.youtube.com/watch?v=hbw7hdyOpq0"},
  {"id":"leg-extension","name":"Leg Extension","muscle":"legs","icon":"🦵","type":"strength","met":4.0,"bodyMap":["quads"],"videoUrl":"https://www.youtube.com/watch?v=tTbJBUKnWU8"},
  {"id":"leg-curl","name":"Leg Curl","muscle":"legs","icon":"🦵","type":"strength","met":4.0,"bodyMap":["hamstrings"],"videoUrl":"https://www.youtube.com/watch?v=hqI59xXChFk"},
  {"id":"romanian-deadlift","name":"Romanian Deadlift","muscle":"legs","icon":"🦵","type":"strength","met":5.5,"bodyMap":["hamstrings","glutes","lower_back"],"videoUrl":"https://www.youtube.com/watch?v=3VXmecChYYM"},
  {"id":"romanian-deadlift-dumbbell","name":"Dumbbell Romanian Deadlift","muscle":"legs","icon":"🦵","type":"strength","met":5.5,"bodyMap":["hamstrings","glutes","lower_back"],"videoUrl":"https://www.youtube.com/watch?v=aa57T45iFSE"},
  {"id":"hip-thrust","name":"Barbell Hip Thrust","muscle":"legs","icon":"🦵","type":"strength","met":5.0,"bodyMap":["glutes","hamstrings"],"videoUrl":"https://www.youtube.com/watch?v=S_uZP4UH6J0"},
  {"id":"calf-raise","name":"Standing Calf Raise","muscle":"legs","icon":"🦵","type":"strength","met":3.5,"bodyMap":["calves"],"videoUrl":"https://www.youtube.com/watch?v=K_jsGgztcGU"},
  {"id":"seated-calf-raise","name":"Seated Calf Raise","muscle":"legs","icon":"🦵","type":"strength","met":3.5,"bodyMap":["calves"],"videoUrl":"https://www.youtube.com/watch?v=ORY-ke6vcgk"},
  {"id":"hack-squat","name":"Hack Squat","muscle":"legs","icon":"🦵","type":"strength","met":6.0,"bodyMap":["quads","glutes"],"videoUrl":"https://www.youtube.com/watch?v=fE5BWPy7uRc"},
  {"id":"goblet-squat","name":"Goblet Squat","muscle":"legs","icon":"🦵","type":"strength","met":5.5,"bodyMap":["quads","glutes"],"videoUrl":"https://www.youtube.com/watch?v=nfX7IFK9UNI"},
  {"id":"box-jump","name":"Box Jump","muscle":"legs","icon":"🦵","type":"bodyweight","met":8.0,"bodyMap":["quads","glutes","calves"],"videoUrl":"https://www.youtube.com/results?search_query=box+jump+proper+form"},

  // ---- SHOULDERS ----
  {"id":"overhead-press","name":"Overhead Press","muscle":"shoulders","icon":"🏋️","type":"strength","met":5.0,"videoUrl":"https://www.youtube.com/watch?v=ZXpdJOLNoWw","bodyMap":["shoulders","triceps"]},
  {"id":"dumbbell-shoulder-press","name":"Dumbbell Shoulder Press","muscle":"shoulders","icon":"🏋️","type":"strength","met":5.0,"bodyMap":["shoulders","triceps"],"videoUrl":"https://www.youtube.com/results?search_query=dumbbell+shoulder+press+proper+form"},
  {"id":"lateral-raise","name":"Lateral Raise","muscle":"shoulders","icon":"🏋️","type":"strength","met":3.5,"bodyMap":["shoulders"],"videoUrl":"https://www.youtube.com/watch?v=3VcKaXpzqRo"},
  {"id":"front-raise","name":"Front Raise","muscle":"shoulders","icon":"🏋️","type":"strength","met":3.5,"bodyMap":["shoulders"],"videoUrl":"https://www.youtube.com/watch?v=-t7fuZ0KhDA"},
  {"id":"rear-delt-fly","name":"Rear Delt Fly","muscle":"shoulders","icon":"🏋️","type":"strength","met":3.5,"bodyMap":["shoulders","upper_back"],"videoUrl":"https://www.youtube.com/watch?v=lPt0GqwaqEw"},
  {"id":"arnold-press","name":"Arnold Press","muscle":"shoulders","icon":"🏋️","type":"strength","met":5.0,"bodyMap":["shoulders","triceps"],"videoUrl":"https://www.youtube.com/watch?v=3ml7BH7mNwQ"},
  {"id":"upright-row","name":"Upright Row","muscle":"shoulders","icon":"🏋️","type":"strength","met":4.5,"bodyMap":["shoulders","upper_back"],"videoUrl":"https://www.youtube.com/watch?v=CmjbusFUzck"},
  {"id":"shoulder-press-machine","name":"Shoulder Press Machine","muscle":"shoulders","icon":"🏋️","type":"strength","met":4.5,"videoUrl":"https://www.youtube.com/watch?v=TnhIyp4kmO8","bodyMap":["shoulders","triceps"]},

  // ---- ARMS ----
  {"id":"bicep-curl-barbell","name":"Barbell Bicep Curl","muscle":"arms","icon":"💪","type":"strength","met":3.5,"bodyMap":["biceps"],"videoUrl":"https://www.youtube.com/watch?v=pQfJR-sSIvA"},
  {"id":"bicep-curl-dumbbell","name":"Dumbbell Bicep Curl","muscle":"arms","icon":"💪","type":"strength","met":3.5,"videoUrl":"https://www.youtube.com/watch?v=6DeLZ6cbgWQ","bodyMap":["biceps"]},
  {"id":"hammer-curl","name":"Hammer Curl","muscle":"arms","icon":"💪","type":"strength","met":3.5,"bodyMap":["biceps","forearms"],"videoUrl":"https://www.youtube.com/watch?v=TwD-YGVP4Bk"},
  {"id":"incline-dumbbell-curl","name":"Incline Dumbbell Curl","muscle":"arms","icon":"💪","type":"strength","met":3.5,"bodyMap":["biceps"],"videoUrl":"https://www.youtube.com/watch?v=DCe8f6vMe9A"},
  {"id":"concentration-curl","name":"Concentration Curl","muscle":"arms","icon":"💪","type":"strength","met":3.5,"bodyMap":["biceps"],"videoUrl":"https://www.youtube.com/watch?v=ZcU2hN76UyA"},
  {"id":"preacher-curl","name":"Preacher Curl","muscle":"arms","icon":"💪","type":"strength","met":3.5,"bodyMap":["biceps"],"videoUrl":"https://www.youtube.com/watch?v=fIWP-FRFNU0"},
  {"id":"tricep-pushdown","name":"Tricep Pushdown","muscle":"arms","icon":"💪","type":"strength","met":3.5,"videoUrl":"https://www.youtube.com/watch?v=LXkCrxn3caQ","bodyMap":["triceps"]},
  {"id":"tricep-kickback-dumbbell","name":"Dumbbell Tricep Kickback","muscle":"arms","icon":"💪","type":"strength","met":3.5,"bodyMap":["triceps"],"videoUrl":"https://www.youtube.com/watch?v=XuH2W_R5YoA"},
  {"id":"tricep-rope-pushdown","name":"Rope Tricep Pushdown","muscle":"arms","icon":"💪","type":"strength","met":3.5,"bodyMap":["triceps"],"videoUrl":"https://www.youtube.com/watch?v=d-ySLTHUgQA"},
  {"id":"tricep-dip","name":"Tricep Dip","muscle":"arms","icon":"💪","type":"bodyweight","met":5.0,"bodyMap":["triceps","chest"],"videoUrl":"https://www.youtube.com/results?search_query=tricep+dips+proper+form"},
  {"id":"skull-crusher","name":"Skull Crusher","muscle":"arms","icon":"💪","type":"strength","met":3.5,"bodyMap":["triceps"],"videoUrl":"https://www.youtube.com/watch?v=kOXVmFFTcio"},
  {"id":"overhead-tricep-extension","name":"Overhead Tricep Extension","muscle":"arms","icon":"💪","type":"strength","met":3.5,"bodyMap":["triceps"],"videoUrl":"https://www.youtube.com/watch?v=qkZBtEHUjfw"},
  {"id":"close-grip-bench","name":"Close-Grip Bench Press","muscle":"arms","icon":"🏋️","type":"strength","met":4.5,"bodyMap":["triceps","chest"],"videoUrl":"https://www.youtube.com/watch?v=VYC2QZEOIUI"},
  {"id":"skull-crusher-dumbbell","name":"Dumbbell Skull Crusher","muscle":"arms","icon":"💪","type":"strength","met":3.5,"bodyMap":["triceps"],"videoUrl":"https://www.youtube.com/watch?v=ir5PsbniVSc"},
  {"id":"overhead-tricep-extension-dumbbell","name":"Dumbbell Overhead Tricep Extension","muscle":"arms","icon":"💪","type":"strength","met":3.5,"bodyMap":["triceps"],"videoUrl":"https://www.youtube.com/watch?v=YbX7Wd8jQ-Q"},
  {"id":"close-grip-dumbbell-press","name":"Close-Grip Dumbbell Press","muscle":"arms","icon":"🏋️","type":"strength","met":4.5,"bodyMap":["triceps","chest"],"videoUrl":"https://www.youtube.com/watch?v=4Z6reBHE-20"},
  {"id":"cable-curl","name":"Cable Bicep Curl","muscle":"arms","icon":"💪","type":"strength","met":3.5,"bodyMap":["biceps"],"videoUrl":"https://www.youtube.com/watch?v=xG57S0fgXAk"},

  // ---- CORE ----
  {"id":"plank","name":"Plank","muscle":"core","icon":"🧘","type":"bodyweight","holdBased":true,"met":3.5,"bodyMap":["abs"],"videoUrl":"https://www.youtube.com/watch?v=pSHjTRCQxIw"},
  {"id":"crunches","name":"Crunches","muscle":"core","icon":"🧘","type":"bodyweight","met":3.5,"bodyMap":["abs"],"videoUrl":"https://www.youtube.com/watch?v=Xyd_fa5zoEU"},
  {"id":"cable-crunch","name":"Kneeling Cable Crunch","muscle":"core","icon":"🧘","type":"strength","met":4.0,"bodyMap":["abs"],"videoUrl":"https://www.youtube.com/watch?v=b9FJ4hIK3pI"},
  {"id":"hanging-leg-raise","name":"Hanging Leg Raise","muscle":"core","icon":"🧘","type":"bodyweight","met":4.5,"bodyMap":["abs"],"videoUrl":"https://www.youtube.com/watch?v=Pr1ieGZ5atk"},
  {"id":"russian-twist","name":"Russian Twist","muscle":"core","icon":"🧘","type":"bodyweight","met":4.0,"bodyMap":["obliques","abs"],"videoUrl":"https://www.youtube.com/watch?v=JyUqwkVpsi8"},
  {"id":"cable-woodchopper","name":"Cable Woodchopper","muscle":"core","icon":"🧘","type":"strength","met":4.0,"bodyMap":["obliques"],"videoUrl":"https://www.youtube.com/watch?v=9LJ3Qp7k4pA"},
  {"id":"ab-wheel","name":"Ab Wheel Rollout","muscle":"core","icon":"🧘","type":"bodyweight","met":4.5,"bodyMap":["abs"],"videoUrl":"https://www.youtube.com/watch?v=ZWdP0v5nX8M"},
  {"id":"mountain-climbers","name":"Mountain Climbers","muscle":"core","icon":"🧘","type":"bodyweight","met":6.0,"bodyMap":["abs"],"videoUrl":"https://www.youtube.com/watch?v=nmwgirgXLYM"},
  {"id":"side-plank","name":"Side Plank","muscle":"core","icon":"🧘","type":"bodyweight","holdBased":true,"met":3.5,"bodyMap":["obliques"],"videoUrl":"https://www.youtube.com/watch?v=K2VljzCC16g"},

  // ---- CARDIO ----
  {"id":"incline-walk","name":"Incline Treadmill Walk","muscle":"cardio","icon":"🚶","type":"cardio","met":0,"special":"incline_walk","bodyMap":[],"videoUrl":"https://www.youtube.com/watch?v=5W2eQ5c9k8Q"},
  {"id":"treadmill-run","name":"Treadmill Run","muscle":"cardio","icon":"🏃","type":"cardio","met":9.8,"bodyMap":["quads","calves"],"videoUrl":"https://www.youtube.com/watch?v=H0u5sJ5J5y8"},
  {"id":"stationary-bike","name":"Stationary Bike","muscle":"cardio","icon":"🚴","type":"cardio","met":7.0,"bodyMap":["quads"],"videoUrl":"https://www.youtube.com/watch?v=8iK5n4cK9bI"},
  {"id":"rowing-machine","name":"Rowing Machine","muscle":"cardio","icon":"🚣","type":"cardio","met":7.0,"bodyMap":["lats","biceps","quads","upper_back"],"videoUrl":"https://www.youtube.com/watch?v=H0rZp7L6p0E"},
  {"id":"elliptical","name":"Elliptical Trainer","muscle":"cardio","icon":"🏃","type":"cardio","met":5.0,"bodyMap":["quads","glutes"],"videoUrl":"https://www.youtube.com/watch?v=Z9Q4K3m4mJ8"},
  {"id":"stairmaster","name":"StairMaster","muscle":"cardio","icon":"🪜","type":"cardio","met":8.8,"bodyMap":["quads","glutes","calves"],"videoUrl":"https://www.youtube.com/watch?v=V1x2Y3z4A5B"},
  {"id":"jump-rope","name":"Jump Rope","muscle":"cardio","icon":"🪢","type":"cardio","met":11.0,"bodyMap":["calves"],"videoUrl":"https://www.youtube.com/watch?v=1BZM2Vre5oc"},
  {"id":"swimming","name":"Swimming (freestyle)","muscle":"cardio","icon":"🏊","type":"cardio","met":8.0,"bodyMap":["lats","shoulders"],"videoUrl":"https://www.youtube.com/watch?v=5HLW2AIgM7I"},
  {"id":"cycling-outdoor","name":"Outdoor Cycling","muscle":"cardio","icon":"🚴","type":"cardio","met":8.0,"bodyMap":["quads"],"videoUrl":"https://www.youtube.com/watch?v=V5Vqf6w7j8k"},
  {"id":"flat-walk","name":"Flat Walk","muscle":"cardio","icon":"🚶","type":"cardio","met":3.5,"bodyMap":[],"videoUrl":"https://www.youtube.com/watch?v=nj7qFj0e9Y8"},

  // ---- FULL BODY ----
  {"id":"clean-and-jerk","name":"Clean and Jerk","muscle":"fullbody","icon":"🏋️","type":"strength","met":7.0,"bodyMap":["quads","glutes","shoulders","upper_back"],"videoUrl":"https://www.youtube.com/watch?v=PjY1rH4_MOA"},
  {"id":"snatch","name":"Snatch","muscle":"fullbody","icon":"🏋️","type":"strength","met":7.0,"bodyMap":["quads","glutes","shoulders","upper_back"],"videoUrl":"https://www.youtube.com/watch?v=9xQ7fJk2QnA"},
  {"id":"kettlebell-swing","name":"Kettlebell Swing","muscle":"fullbody","icon":"🏋️","type":"strength","met":6.5,"bodyMap":["glutes","hamstrings","lower_back"],"videoUrl":"https://www.youtube.com/watch?v=YSx3jYkV7Jg"},
  {"id":"farmers-walk","name":"Farmer's Walk","muscle":"fullbody","icon":"🏋️","type":"strength","met":5.5,"bodyMap":["forearms","upper_back"],"videoUrl":"https://www.youtube.com/watch?v=Fkzk_RqlYig"},
  {"id":"burpees","name":"Burpees","muscle":"fullbody","icon":"💪","type":"bodyweight","met":8.0,"bodyMap":["chest","quads","shoulders"],"videoUrl":"https://www.youtube.com/watch?v=TU8QYVW0gDU"},
  {"id":"thruster","name":"Thruster","muscle":"fullbody","icon":"🏋️","type":"strength","met":7.0,"bodyMap":["quads","glutes","shoulders"],"videoUrl":"https://www.youtube.com/watch?v=L219ltL15zk"},
  {"id":"battle-ropes","name":"Battle Ropes","muscle":"fullbody","icon":"🏋️","type":"cardio","met":7.5,"bodyMap":["shoulders","forearms"],"videoUrl":"https://youtube.com/watch?v=pQb2xIGioyQ"}
];

const MUSCLE_GROUPS = [
  {id:'all', label:'All'},
  {id:'chest', label:'Chest'},
  {id:'back', label:'Back'},
  {id:'legs', label:'Legs'},
  {id:'shoulders', label:'Shoulders'},
  {id:'arms', label:'Arms'},
  {id:'core', label:'Core'},
  {id:'cardio', label:'Cardio'},
  {id:'fullbody', label:'Full Body'},
];