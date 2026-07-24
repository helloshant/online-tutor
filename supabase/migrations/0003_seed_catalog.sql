-- Seed catalog data: boards, grades, subjects, offerings, and a sample
-- syllabus. This is representative/illustrative content (not an official,
-- exhaustive reproduction of any board's syllabus) meant to demonstrate that
-- Q&A scoping genuinely differs per board/grade/subject. Admins should
-- extend and correct this via the Admin > Catalog panel with the official
-- syllabus for every grade/board they actually offer.

insert into public.boards (name, code) values
  ('CBSE', 'CBSE'),
  ('ICSE', 'ICSE'),
  ('West Bengal Board', 'WBBSE')
on conflict do nothing;

insert into public.grades (name, level) values
  ('Grade 6', 6),
  ('Grade 7', 7),
  ('Grade 8', 8),
  ('Grade 9', 9),
  ('Grade 10', 10),
  ('Grade 11', 11),
  ('Grade 12', 12)
on conflict do nothing;

insert into public.subjects (name, code) values
  ('Mathematics', 'MATH'),
  ('Physics', 'PHY'),
  ('Chemistry', 'CHEM'),
  ('Biology', 'BIO'),
  ('English', 'ENG'),
  ('Geography', 'GEO')
on conflict do nothing;

-- Offer every subject for every board/grade combination. Trim per-board via
-- the admin catalog editor if a board doesn't actually offer a subject at a
-- given grade.
insert into public.board_grade_subjects (board_id, grade_id, subject_id)
select b.id, g.id, s.id
from public.boards b
cross join public.grades g
cross join public.subjects s
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Sample syllabus: Grade 9, all subjects, all three boards -- the scenario
-- called out explicitly in the product spec (a Grade 9 WB Board student's
-- syllabus differs from CBSE/ICSE).
-- ---------------------------------------------------------------------------
insert into public.syllabus_topics (board_id, grade_id, subject_id, chapter, topic, sort_order)
select b.id, g.id, s.id, v.chapter, v.topic, v.sort_order
from (
  values
    -- CBSE Grade 9 -----------------------------------------------------
    ('CBSE','Grade 9','Mathematics','Number Systems','Rational & irrational numbers, real numbers on the number line, laws of exponents',1),
    ('CBSE','Grade 9','Mathematics','Polynomials','Polynomials in one variable, zeros, remainder & factor theorem, algebraic identities',2),
    ('CBSE','Grade 9','Mathematics','Coordinate Geometry','Cartesian plane, plotting points',3),
    ('CBSE','Grade 9','Mathematics','Linear Equations in Two Variables','Graph of a linear equation, solutions',4),
    ('CBSE','Grade 9','Mathematics','Triangles','Congruence rules, properties of triangles',5),
    ('CBSE','Grade 9','Mathematics','Circles','Angle subtended by a chord, cyclic quadrilaterals',6),
    ('CBSE','Grade 9','Mathematics','Heron''s Formula','Area of a triangle using Heron''s formula',7),
    ('CBSE','Grade 9','Mathematics','Statistics','Collection, presentation & analysis of data, mean, median, mode',8),
    ('CBSE','Grade 9','Mathematics','Probability','Empirical probability of events',9),

    ('CBSE','Grade 9','Physics','Motion','Distance, displacement, velocity, acceleration, equations of motion',1),
    ('CBSE','Grade 9','Physics','Force and Laws of Motion','Newton''s laws, inertia, momentum',2),
    ('CBSE','Grade 9','Physics','Gravitation','Universal law of gravitation, free fall, mass vs weight',3),
    ('CBSE','Grade 9','Physics','Work and Energy','Work done, kinetic & potential energy, power',4),
    ('CBSE','Grade 9','Physics','Sound','Production & propagation of sound, reflection, echo',5),

    ('CBSE','Grade 9','Chemistry','Matter in Our Surroundings','States of matter, change of state, evaporation',1),
    ('CBSE','Grade 9','Chemistry','Is Matter Around Us Pure','Mixtures, solutions, suspensions, colloids, separation techniques',2),
    ('CBSE','Grade 9','Chemistry','Atoms and Molecules','Laws of chemical combination, atomic & molecular mass, mole concept',3),
    ('CBSE','Grade 9','Chemistry','Structure of the Atom','Sub-atomic particles, Bohr model, valency, isotopes',4),

    ('CBSE','Grade 9','Biology','The Fundamental Unit of Life','Cell structure, organelles, cell theory',1),
    ('CBSE','Grade 9','Biology','Tissues','Plant & animal tissues',2),
    ('CBSE','Grade 9','Biology','Diversity in Living Organisms','Classification, five kingdom system',3),
    ('CBSE','Grade 9','Biology','Why Do We Fall Ill','Health, disease, pathogens, prevention',4),
    ('CBSE','Grade 9','Biology','Natural Resources','Air, water, soil, biogeochemical cycles',5),

    ('CBSE','Grade 9','English','Beehive - Prose & Poetry','NCERT Beehive textbook chapters and poems',1),
    ('CBSE','Grade 9','English','Grammar','Tenses, modals, subject-verb agreement, determiners',2),
    ('CBSE','Grade 9','English','Writing Skills','Diary entry, letter writing, story writing, notice',3),
    ('CBSE','Grade 9','English','Moments - Supplementary Reader','Short stories from the supplementary textbook',4),

    ('CBSE','Grade 9','Geography','India - Size and Location','Location, boundaries, physiographic divisions',1),
    ('CBSE','Grade 9','Geography','Physical Features of India','Mountains, plains, plateaus, coasts, islands',2),
    ('CBSE','Grade 9','Geography','Drainage','Major rivers and river systems of India',3),
    ('CBSE','Grade 9','Geography','Climate','Monsoons, seasons, climatic regions',4),
    ('CBSE','Grade 9','Geography','Natural Vegetation and Wildlife','Forest types, wildlife conservation',5),

    -- ICSE Grade 9 -------------------------------------------------------
    ('ICSE','Grade 9','Mathematics','Rational and Irrational Numbers','Number system, surds, rationalisation',1),
    ('ICSE','Grade 9','Mathematics','Compound Interest','Compound interest using the formula, growth & depreciation',2),
    ('ICSE','Grade 9','Mathematics','Expansions and Factorisation','Algebraic identities, factorisation of polynomials',3),
    ('ICSE','Grade 9','Mathematics','Simultaneous Linear Equations','Solving pairs of linear equations, word problems',4),
    ('ICSE','Grade 9','Mathematics','Indices and Logarithms','Laws of indices, introduction to logarithms',5),
    ('ICSE','Grade 9','Mathematics','Triangles and Mid-Point Theorem','Congruency, mid-point theorem, Pythagoras theorem',6),
    ('ICSE','Grade 9','Mathematics','Rectilinear Figures','Properties of parallelograms, quadrilaterals',7),
    ('ICSE','Grade 9','Mathematics','Statistics','Mean, median, mode, histograms, ogives',8),

    ('ICSE','Grade 9','Physics','Measurements and Experimentation','Units, vernier calipers, screw gauge, significant figures',1),
    ('ICSE','Grade 9','Physics','Motion in One Dimension','Speed, velocity, acceleration, graphs of motion',2),
    ('ICSE','Grade 9','Physics','Laws of Motion','Newton''s laws, momentum, friction',3),
    ('ICSE','Grade 9','Physics','Fluids','Pressure, Archimedes'' principle, buoyancy',4),
    ('ICSE','Grade 9','Physics','Heat and Energy','Calorimetry, specific heat capacity',5),
    ('ICSE','Grade 9','Physics','Light','Reflection, refraction, spherical mirrors',6),
    ('ICSE','Grade 9','Physics','Sound','Wave nature of sound, loudness, pitch, quality',7),

    ('ICSE','Grade 9','Chemistry','Matter and its Composition','Elements, compounds, mixtures, atomic theory',1),
    ('ICSE','Grade 9','Chemistry','Chemical Change and Reactions','Types of chemical change and reactions',2),
    ('ICSE','Grade 9','Chemistry','Water','Physical/chemical properties, hydrates, hard & soft water',3),
    ('ICSE','Grade 9','Chemistry','Atomic Structure and Chemical Bonding','Sub-atomic particles, electronic configuration, bonding',4),
    ('ICSE','Grade 9','Chemistry','The Periodic Table','Periods, groups, periodicity of properties',5),
    ('ICSE','Grade 9','Chemistry','Study of Gas Laws','Boyle''s law, Charles'' law, mole concept',6),

    ('ICSE','Grade 9','Biology','Cell - The Unit of Life','Cell structure, plant vs animal cells, cell division',1),
    ('ICSE','Grade 9','Biology','Plant Physiology','Photosynthesis, respiration, transpiration',2),
    ('ICSE','Grade 9','Biology','Diversity in Living Organisms','Five kingdom classification, binomial nomenclature',3),
    ('ICSE','Grade 9','Biology','Human Anatomy and Physiology','Skeletal system, digestive system',4),
    ('ICSE','Grade 9','Biology','Health Organisations','WHO, Red Cross, and public health awareness',5),

    ('ICSE','Grade 9','English','Literature - Prose, Poetry & Drama','Prescribed literature texts (ICSE Treasure Trove and set texts)',1),
    ('ICSE','Grade 9','English','Composition','Essay, article and formal/informal letter writing',2),
    ('ICSE','Grade 9','English','Grammar and Usage','Structured grammar exercises, editing, transformation',3),
    ('ICSE','Grade 9','English','Comprehension','Unseen passage comprehension and précis',4),

    ('ICSE','Grade 9','Geography','Geographical Data - Location, Distance, Direction','Map reading fundamentals, scale, direction',1),
    ('ICSE','Grade 9','Geography','Insolation, Temperature and Air Pressure','Factors affecting insolation and atmospheric pressure',2),
    ('ICSE','Grade 9','Geography','Winds','Planetary winds, monsoons, local winds',3),
    ('ICSE','Grade 9','Geography','Water in the Atmosphere','Humidity, condensation, precipitation types',4),
    ('ICSE','Grade 9','Geography','Rocks and Weathering','Igneous, sedimentary, metamorphic rocks; weathering processes',5),
    ('ICSE','Grade 9','Geography','Map Work','Four-figure and six-figure grid references, conventional signs',6),

    -- West Bengal Board Grade 9 -------------------------------------------
    ('West Bengal Board','Grade 9','Mathematics','Real Numbers','Properties of real numbers, laws of indices',1),
    ('West Bengal Board','Grade 9','Mathematics','Simplification of Surds','Surds and their simplification',2),
    ('West Bengal Board','Grade 9','Mathematics','Profit, Loss, Simple and Compound Interest','Applications of mathematical calculation in daily life',3),
    ('West Bengal Board','Grade 9','Mathematics','Variation','Direct and inverse variation',4),
    ('West Bengal Board','Grade 9','Mathematics','Theorems on Area','Area relationships between triangles and parallelograms',5),
    ('West Bengal Board','Grade 9','Mathematics','Rules of Co-ordinate Geometry','Distance formula, plotting points',6),
    ('West Bengal Board','Grade 9','Mathematics','Polynomial and Factorization','Factor theorem, factorisation of polynomials',7),
    ('West Bengal Board','Grade 9','Mathematics','Statistics','Mean, median, mode, tabulation of data',8),
    ('West Bengal Board','Grade 9','Mathematics','Trigonometry - Measurement of Angle','Sexagesimal, radian measure of angles',9),

    ('West Bengal Board','Grade 9','Physics','Measurement','Units and measurement, dimensional analysis',1),
    ('West Bengal Board','Grade 9','Physics','Motion','Scalars, vectors, equations of motion',2),
    ('West Bengal Board','Grade 9','Physics','Force and Motion','Newton''s laws of motion, momentum',3),
    ('West Bengal Board','Grade 9','Physics','Work, Power and Energy','Work-energy theorem, forms of energy',4),
    ('West Bengal Board','Grade 9','Physics','Heat and Temperature','Thermometry, thermal expansion',5),

    ('West Bengal Board','Grade 9','Chemistry','Physical and Chemical Changes','Distinguishing physical and chemical changes',1),
    ('West Bengal Board','Grade 9','Chemistry','Atoms and Molecules','Atomic and molecular mass, mole concept',2),
    ('West Bengal Board','Grade 9','Chemistry','Behaviour of Gases','Gas laws, kinetic theory of gases',3),
    ('West Bengal Board','Grade 9','Chemistry','Structure of Atom','Atomic models, sub-atomic particles',4),
    ('West Bengal Board','Grade 9','Chemistry','Periodic Table and Periodicity','Modern periodic table, periodic trends',5),

    ('West Bengal Board','Grade 9','Biology','Characteristics of Living Organisms','Life processes common to all organisms',1),
    ('West Bengal Board','Grade 9','Biology','Cell: Structure and Function','Cell organelles, cell division',2),
    ('West Bengal Board','Grade 9','Biology','Biological Diversity and Classification','Taxonomy, five kingdom classification',3),
    ('West Bengal Board','Grade 9','Biology','Environment, Resources and Conservation','Ecosystems, natural resource conservation',4),

    ('West Bengal Board','Grade 9','English','Prose and Poetry','Prescribed WBBSE textbook chapters and poems',1),
    ('West Bengal Board','Grade 9','English','Grammar and Composition','Tense, voice, narration, transformation of sentences',2),
    ('West Bengal Board','Grade 9','English','Writing Skills','Letter, paragraph, report and notice writing',3),

    ('West Bengal Board','Grade 9','Geography','The Universe and the Earth','Origin of the universe, solar system, earth''s motions',1),
    ('West Bengal Board','Grade 9','Geography','Geographical Environment as a Resource','Natural resources and their conservation',2),
    ('West Bengal Board','Grade 9','Geography','Landforms and their Evolution','Endogenic and exogenic processes, landform evolution',3),
    ('West Bengal Board','Grade 9','Geography','Weather and Climate','Elements of weather and climate, climatic regions',4),
    ('West Bengal Board','Grade 9','Geography','Water: The Vital Resource','Hydrological cycle, distribution of water resources',5),

    -- ---------------------------------------------------------------
    -- Grade 10 -- a lighter sample (Mathematics, Physics, Chemistry,
    -- Biology) showing how the syllabus progresses and still differs by
    -- board. Extend via Admin > Catalog for the remaining subjects.
    -- ---------------------------------------------------------------
    ('CBSE','Grade 10','Mathematics','Real Numbers','Euclid''s division lemma, fundamental theorem of arithmetic',1),
    ('CBSE','Grade 10','Mathematics','Polynomials','Zeros of a polynomial, relationship with coefficients',2),
    ('CBSE','Grade 10','Mathematics','Pair of Linear Equations in Two Variables','Graphical & algebraic methods of solving',3),
    ('CBSE','Grade 10','Mathematics','Quadratic Equations','Solving by factorisation, completing the square, formula',4),
    ('CBSE','Grade 10','Mathematics','Arithmetic Progressions','nth term, sum of n terms',5),
    ('CBSE','Grade 10','Mathematics','Trigonometry','Trigonometric ratios, identities, heights and distances',6),
    ('CBSE','Grade 10','Mathematics','Circles','Tangent to a circle, number of tangents',7),

    ('CBSE','Grade 10','Physics','Light - Reflection and Refraction','Spherical mirrors, lenses, refractive index',1),
    ('CBSE','Grade 10','Physics','The Human Eye and the Colourful World','Defects of vision, dispersion, scattering',2),
    ('CBSE','Grade 10','Physics','Electricity','Ohm''s law, resistance, series & parallel circuits',3),
    ('CBSE','Grade 10','Physics','Magnetic Effects of Electric Current','Magnetic field, electromagnetic induction',4),

    ('CBSE','Grade 10','Chemistry','Chemical Reactions and Equations','Types of chemical reactions, balancing equations',1),
    ('CBSE','Grade 10','Chemistry','Acids, Bases and Salts','Properties, pH scale, common salts',2),
    ('CBSE','Grade 10','Chemistry','Metals and Non-metals','Physical/chemical properties, reactivity series',3),
    ('CBSE','Grade 10','Chemistry','Carbon and its Compounds','Covalent bonding, homologous series, functional groups',4),

    ('CBSE','Grade 10','Biology','Life Processes','Nutrition, respiration, transportation, excretion',1),
    ('CBSE','Grade 10','Biology','Control and Coordination','Nervous system, hormones in animals and plants',2),
    ('CBSE','Grade 10','Biology','How do Organisms Reproduce','Modes of reproduction in plants and animals',3),
    ('CBSE','Grade 10','Biology','Heredity and Evolution','Mendelian genetics, evolution, speciation',4),

    ('ICSE','Grade 10','Mathematics','Commercial Mathematics - GST and Banking','GST computation, recurring deposit accounts',1),
    ('ICSE','Grade 10','Mathematics','Linear Inequations','Solving linear inequations and graphing solutions',2),
    ('ICSE','Grade 10','Mathematics','Quadratic Equations','Nature of roots, solving by formula and factorisation',3),
    ('ICSE','Grade 10','Mathematics','Ratio and Proportion','Componendo-dividendo, direct applications',4),
    ('ICSE','Grade 10','Mathematics','Coordinate Geometry','Equation of a line, section formula',5),
    ('ICSE','Grade 10','Mathematics','Trigonometry','Trigonometric identities, heights and distances',6),
    ('ICSE','Grade 10','Mathematics','Circles','Chords, tangents, angle properties',7),

    ('ICSE','Grade 10','Physics','Force, Work, Power and Energy','Moments, mechanical advantage, energy conservation',1),
    ('ICSE','Grade 10','Physics','Light','Refraction through a lens, total internal reflection',2),
    ('ICSE','Grade 10','Physics','Current Electricity','Ohm''s law, resistors in series/parallel, electrical power',3),
    ('ICSE','Grade 10','Physics','Electromagnetism and Calorimetry','Electromagnetic induction, specific heat',4),

    ('ICSE','Grade 10','Chemistry','Periodic Properties and Variation of Properties','Periodic trends across groups and periods',1),
    ('ICSE','Grade 10','Chemistry','Chemical Bonding','Ionic and covalent bonding',2),
    ('ICSE','Grade 10','Chemistry','Study of Acids, Bases and Salts','Properties, preparation, and uses',3),
    ('ICSE','Grade 10','Chemistry','Organic Chemistry','Structure of organic compounds, homologous series',4),

    ('ICSE','Grade 10','Biology','Structure of Chromosomes and Cell Division','Mitosis, meiosis, chromosome structure',1),
    ('ICSE','Grade 10','Biology','Genetics','Mendelian inheritance, monohybrid cross',2),
    ('ICSE','Grade 10','Biology','The Circulatory System','Heart, blood vessels, blood composition',3),
    ('ICSE','Grade 10','Biology','The Excretory System','Structure and function of the kidney',4),

    ('West Bengal Board','Grade 10','Mathematics','Theorems Related to Circle','Circle theorems, tangents',1),
    ('West Bengal Board','Grade 10','Mathematics','Quadratic Equations','Solving quadratic equations, nature of roots',2),
    ('West Bengal Board','Grade 10','Mathematics','Ratio and Proportion','Componendo-dividendo and applications',3),
    ('West Bengal Board','Grade 10','Mathematics','Trigonometric Ratios and Identities','Trigonometric ratios, identities, heights & distances',4),
    ('West Bengal Board','Grade 10','Mathematics','Statistics','Mean, median, mode, mean deviation',5),
    ('West Bengal Board','Grade 10','Mathematics','Coordinate Geometry','Distance formula, area of a triangle',6),

    ('West Bengal Board','Grade 10','Physics','Environment and its Resources','Environmental resources and their utilisation',1),
    ('West Bengal Board','Grade 10','Physics','Motion in a Straight Line','Uniform and non-uniform motion, graphs',2),
    ('West Bengal Board','Grade 10','Physics','Force, Gravitation','Newton''s law of gravitation, weight and mass',3),
    ('West Bengal Board','Grade 10','Physics','Heat Phenomena','Calorimetry, change of state',4),

    ('West Bengal Board','Grade 10','Chemistry','Gaseous State of Matter','Gas laws, ideal gas equation',1),
    ('West Bengal Board','Grade 10','Chemistry','Periodic Table and Periodicity','Modern periodic law, trends in properties',2),
    ('West Bengal Board','Grade 10','Chemistry','Chemical Calculations','Mole concept, stoichiometry',3),
    ('West Bengal Board','Grade 10','Chemistry','Electrochemistry','Electrolysis, electrochemical cells',4),

    ('West Bengal Board','Grade 10','Biology','Control and Co-ordination in Living Organisms','Nervous and hormonal coordination',1),
    ('West Bengal Board','Grade 10','Biology','Life Processes - Nutrition and Respiration','Modes of nutrition, respiration in organisms',2),
    ('West Bengal Board','Grade 10','Biology','Reproduction in Living Organisms','Sexual and asexual reproduction',3),
    ('West Bengal Board','Grade 10','Biology','Environment, its Resources and Biodiversity','Ecosystem, biodiversity conservation',4)
) as v(board, grade, subject, chapter, topic, sort_order)
join public.boards b on b.name = v.board
join public.grades g on g.name = v.grade
join public.subjects s on s.name = v.subject
on conflict do nothing;
