import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, ArrowLeft, User, Upload, Edit2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { usersApi } from '../lib/api/users';
import { authService } from '../lib/auth';
import { logError } from '../lib/monitoring';

/**
 * Edit-profile screen.
 *
 * Navigation goes through react-router's `useNavigate`, not the optional
 * `onNavigate` prop this component used to take. The route renders
 * <EditProfilePage /> with no props, so every `onNavigate?.(...)` call was a
 * no-op: the Cancel/back buttons did nothing, and saving left the user
 * sitting on the edit form instead of returning to their profile.
 */
export function EditProfilePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [formData, setFormData] = useState({
    full_name: '',
    bio: '',
    location: '',
    social_links: {
      twitter: '',
      linkedin: '',
      github: '',
    },
  });
  const [profilePhotoFile, setProfilePhotoFile] = useState<File | null>(null);
  const [coverPhotoFile, setCoverPhotoFile] = useState<File | null>(null);
  const [profilePhotoPreview, setProfilePhotoPreview] = useState<string>('');
  const [coverPhotoPreview, setCoverPhotoPreview] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadUserData();
  }, []);

  const loadUserData = async () => {
    if (!user) return;
    try {
      setLoading(true);
      /**
       * The caller's OWN record, not the directory view.
       *
       * `usersApi.getUserById` goes through `users.getById` -> `directoryShape`,
       * which deliberately omits socialLinks and coverPhotoUrl — they are not
       * things every member needs about every other member. This form loaded
       * from it, so the social fields always came back EMPTY, and saving then
       * sent those blanks through `updateMyProfile`, silently erasing whatever
       * the user had previously set. Every save destroyed data.
       *
       * `refreshUser()` reads `auth.me` -> `publicUser`, which is the caller's
       * full self shape and does carry both.
       */
      const userData = await authService.refreshUser();
      if (!userData) {
        logError(new Error('User data not found'), { context: 'EditProfilePage.loadUserData' });
        toast.error('Failed to load user data');
        return;
      }
      setFormData({
        full_name: userData.full_name || '',
        bio: userData.bio || '',
        location: userData.location || '',
        social_links: {
          twitter: userData.social_links?.twitter ?? '',
          linkedin: userData.social_links?.linkedin ?? '',
          github: userData.social_links?.github ?? '',
        },
      });
      setProfilePhotoPreview(userData.profile_photo_url || '');
      setCoverPhotoPreview(userData.cover_photo_url || '');
    } catch (error) {
      logError(error, { context: 'EditProfilePage.loadUserData' });
      toast.error('Failed to load user data. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleProfilePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setProfilePhotoFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setProfilePhotoPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleCoverPhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setCoverPhotoFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setCoverPhotoPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };


  const handleSave = async () => {
    if (!user) {
      toast.error('Please log in again');
      return;
    }

    if (!formData.full_name.trim()) {
      toast.error('Full name is required');
      return;
    }

    try {
      setSaving(true);

      // storageUtils, not the inline uploader.
      //
      // This wrote to `profile-photos` and `cover-photos`, and NEITHER BUCKET
      // EXISTS in the Supabase project — every photo change from this page has
      // been failing in production. `api/users.ts` uploaded the same thing to
      // `orbit_profile_photos`, which does work, so there were two paths to one
      // feature and this was the broken one.
      //
      // The attach mutations also record the storage id, so replacing a photo
      // deletes the object it replaced; Convex never reclaims storage, and
      // without that every change would leak a file billed forever.
      if (profilePhotoFile) {
        await usersApi.uploadProfilePhoto(user.id, profilePhotoFile);
      }

      if (coverPhotoFile) {
        await usersApi.uploadCoverPhoto(user.id, coverPhotoFile);
      }

      await usersApi.updateUser(user.id, {
        full_name: formData.full_name,
        bio: formData.bio,
        location: formData.location,
        social_links: formData.social_links,
        // profile_photo_url / cover_photo_url are NOT sent: setProfilePhoto
        // already wrote them alongside the storage id it needs to reclaim the
        // old object. Sending them here would be a second writer for the same
        // field, which is how the id and the url drift apart.
      });

      toast.success('Profile updated!');

      navigate('/profile');
    } catch (error) {
      logError(error, { context: 'EditProfilePage.handleSave' });
      toast.error(`Failed to update profile: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-iih-green mx-auto"></div>
          <p className="mt-4 text-slate-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <button
            onClick={() => navigate('/profile')}
            className="flex items-center gap-2 text-slate-600 hover:text-slate-900 font-medium mb-4"
          >
            <ArrowLeft className="w-5 h-5" />
            Back to Profile
          </button>
          <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
            <Edit2 className="w-8 h-8 text-iih-green" />
            Edit Profile
          </h1>
          <p className="text-slate-600 mt-1">Update your profile information</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mb-6">
          <div className="relative h-48 bg-slate-200">
            {coverPhotoPreview ? (
              <img src={coverPhotoPreview} alt="Cover" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-slate-400">
                No cover photo
              </div>
            )}
            <label className="absolute bottom-4 right-4 bg-white hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-lg font-medium shadow-lg cursor-pointer transition-colors">
              <Upload className="w-4 h-4 inline mr-2" />
              Change Cover
              <input
                type="file"
                accept="image/*"
                onChange={handleCoverPhotoChange}
                className="hidden"
              />
            </label>
          </div>

          <div className="relative px-6 pb-6">
            <div className="relative -mt-16 mb-4">
              <div className="w-32 h-32 rounded-full border-4 border-white bg-slate-200 overflow-hidden">
                {profilePhotoPreview ? (
                  <img src={profilePhotoPreview} alt="Profile" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-slate-400">
                    <User className="w-12 h-12" />
                  </div>
                )}
              </div>
              <label className="absolute bottom-0 right-0 bg-iih-green hover:bg-iih-green-dark text-white p-2 rounded-full shadow-lg cursor-pointer transition-colors">
                <Upload className="w-4 h-4" />
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleProfilePhotoChange}
                  aria-label="Change profile photo"
                  className="hidden"
                />
              </label>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-6">
          <div>
            <label htmlFor="profile-full-name" className="block text-sm font-medium text-slate-700 mb-2">
              Full Name
            </label>
            <input
              id="profile-full-name"
              type="text"
              value={formData.full_name}
              onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
              placeholder="Your full name"
            />
          </div>

          <div>
            <label htmlFor="profile-bio" className="block text-sm font-medium text-slate-700 mb-2">
              Bio
            </label>
            <textarea
              id="profile-bio"
              value={formData.bio}
              onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
              rows={4}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
              placeholder="Tell us about yourself..."
            />
          </div>

          <div>
            <label htmlFor="profile-location" className="block text-sm font-medium text-slate-700 mb-2">
              Location
            </label>
            <input
              id="profile-location"
              type="text"
              value={formData.location}
              onChange={(e) => setFormData({ ...formData, location: e.target.value })}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
              placeholder="City, Country"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-4">
              Social Links
            </label>
            <div className="space-y-3">
              <input
                type="text"
                aria-label="Twitter username"
                value={formData.social_links.twitter || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  social_links: { ...formData.social_links, twitter: e.target.value }
                })}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                placeholder="Twitter username (without @)"
              />
              <input
                type="text"
                aria-label="LinkedIn profile URL"
                value={formData.social_links.linkedin || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  social_links: { ...formData.social_links, linkedin: e.target.value }
                })}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                placeholder="LinkedIn profile URL"
              />
              <input
                type="text"
                aria-label="GitHub username"
                value={formData.social_links.github || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  social_links: { ...formData.social_links, github: e.target.value }
                })}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                placeholder="GitHub username"
              />
            </div>
          </div>

          <div className="flex gap-4 pt-4">
            <button
              onClick={handleSave}
              disabled={saving}
              className="bg-iih-green hover:bg-iih-green-dark text-white px-6 py-3 rounded-lg font-semibold flex items-center gap-2 transition-colors disabled:opacity-50"
            >
              <Save className="w-5 h-5" />
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
            <button
              onClick={() => navigate('/profile')}
              className="bg-white hover:bg-slate-50 text-slate-700 px-6 py-3 rounded-lg font-semibold border border-slate-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
