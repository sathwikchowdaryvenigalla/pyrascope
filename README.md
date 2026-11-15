# 🔥 PyraScope
### One Earth. Two Satellites. A Clearer View.

**PyraScope** is an interactive satellite-based wildfire observation, harmonization, and historical intelligence platform developed for the **NASA Space Apps Challenge 2026**.

PyraScope brings together active-fire observations from NASA's **MODIS and VIIRS satellite systems**, transforming complex Earth-observation data into an interactive experience that helps users explore wildfire activity geographically and over time.

Our mission is to make satellite fire information easier to access, explore, compare, and understand.

---

## 🌍 The Problem

Wildfire activity is a significant environmental concern. Satellites provide valuable observations of active-fire locations across the globe, but understanding these observations can be challenging when information comes from different satellite systems, data formats, spatial resolutions, and observation characteristics.

Looking at individual hotspots alone does not reveal the complete picture. Understanding geographical distribution, historical patterns, seasonal variations, and changes in fire intensity requires a more connected approach.

**PyraScope addresses this challenge by bringing satellite observations and interactive analysis together in one platform.**

---

## 🚀 Our Solution

PyraScope provides an interactive environment where users can explore satellite-based fire observations through a 3D Earth globe, geographical selection, time-based navigation, and analytical visualizations.

By working with MODIS and VIIRS observations, PyraScope aims to provide a more comprehensive view of global fire activity while preserving the identity and characteristics of each satellite source.

---

## ✨ Key Features

### 🌐 1. Interactive 3D Earth Globe
- Explore fire observations on an interactive 3D globe.
- Navigate across geographical regions.
- Zoom into areas of interest.
- Visualize the geographical distribution of fire observations.

### 🛰️ 2. MODIS and VIIRS Data Exploration
- Work with active-fire observations from NASA's MODIS and VIIRS satellite systems.
- Bring observations into a common exploration experience.
- Preserve source-specific information and measurement characteristics.
- Compare observations from different satellite systems.

### 📍 3. Geographical Exploration
- Explore fire activity across different geographical areas.
- Select regions and examine their available observations.
- Support location-based analysis and discovery.

### 📅 4. Interactive Fire Activity Calendar
- Explore fire observations across different dates.
- Identify periods with comparatively higher observation activity.
- Use visual intensity indicators to understand temporal patterns.

### 🔎 5. Detailed Fire Observation Information
Explore available observation attributes, including:
- Latitude and longitude.
- Acquisition date and time.
- Satellite and instrument information.
- Fire Radiative Power (FRP).
- Confidence level.
- Day/night classification, where available.

### 📊 6. Historical Fire Intelligence
One of PyraScope's central capabilities is its focus on historical fire analysis.

Users can explore available historical observations for selected geographical areas and investigate:

- Year-by-year fire observation trends.
- Monthly and seasonal activity patterns.
- Historical intensity variations using FRP.
- Geographical distribution of recurring observations.
- Comparisons between MODIS and VIIRS observations.
- Long-term changes in observed fire activity.

The goal is to move beyond simply displaying hotspots and help users understand the patterns behind them.

### 🌱 7. Environmental Context
PyraScope is designed to support environmental interpretation by incorporating relevant geographical and environmental information where supporting datasets are available.

Potential context includes:
- Vegetation and land-cover information.
- Forest and habitat regions.
- Protected areas.
- Nearby settlements.
- Air-quality information.

Environmental impacts are distinguished from direct satellite observations and are not assumed from hotspot or FRP values alone.

---

## ⚙️ How It Works

PyraScope follows a geospatial data-processing and visualization workflow:

1. **Satellite Data:** Active-fire observations are obtained from NASA's MODIS and VIIRS data sources.
2. **Data Processing:** Google Earth Engine supports access to and processing of geospatial datasets.
3. **Data Harmonization:** Observations are organized into a common structure while retaining their original satellite-specific attributes.
4. **Backend Processing:** Python and FastAPI support data processing and API communication.
5. **Frontend Visualization:** React and Three.js provide the interactive application and 3D globe experience.
6. **Historical Analysis:** Observation records are organized into geographical and temporal summaries to support trend exploration.

---

## 🧰 Technology Stack

| Category | Technologies |
|---|---|
| Satellite Data | NASA MODIS and VIIRS |
| Geospatial Processing | Google Earth Engine |
| Frontend | React, JavaScript |
| Backend | Python, FastAPI |
| 3D Visualization | Three.js |
| Web Technologies | HTML, CSS |
| Development Environment | Visual Studio Code |
| Version Control | Git and GitHub |

---

## 🎯 Intended Impact

PyraScope aims to make satellite-based fire information more accessible and understandable.

Its intended users include:
- Environmental researchers.
- Students and educators.
- Wildlife and forest conservation organizations.
- Environmental analysts.
- People interested in understanding wildfire patterns.

By combining geographical visualization, satellite observation comparison, and historical intelligence, PyraScope aims to support environmental awareness, wildfire research, and better-informed preparedness and management decisions.

---

## 🔬 Scientific Considerations

PyraScope recognizes several important limitations of satellite fire observations:

- A hotspot observation does not automatically represent a unique fire event.
- MODIS and VIIRS have different spatial resolutions and sensor characteristics.
- Repeated satellite observations may correspond to the same ongoing fire.
- Fire Radiative Power is not a direct measurement of burned area or environmental damage.
- Satellite observations alone cannot establish the cause of a fire.
- Historical comparisons must account for changes in sensor availability and data coverage.

Scientific accuracy and transparent interpretation are important principles in PyraScope.

---

## 🏆 NASA Space Apps Challenge 2026

**Challenge:** Harmonization of MODIS and VIIRS Hot Spots

**Project:** PyraScope

**Team:** 012 – Cooking Machine

**Team Code:** NASA-2026-VSK-012

**Local Event:** Visakhapatnam, India

---

## 🌎 Our Vision

We envision a platform where complex satellite observations become easier to explore, compare, and interpret.

By connecting two powerful satellite observation systems with interactive geographical visualization and historical intelligence, PyraScope aims to provide a clearer view of wildfire activity across our planet.

**One Earth. Two Satellites. A Clearer View.**

---

*Built with curiosity, technology, and a vision for a more informed understanding of our changing planet.*
